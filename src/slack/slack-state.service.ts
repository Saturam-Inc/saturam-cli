import { getLogger } from "log4js";
import { Service } from "typedi";
import { resolveAwsClientConfig } from "../integrations/aws/utils/aws-credentials.util";
import { ConfigService } from "../services/config-service";
import type { FeedbackJob } from "./slack-jobs";

const logger = getLogger("SlackState");

/** Long past Slack's last retry (about an hour after the original delivery). */
const DEDUPE_TTL_SECONDS = 2 * 60 * 60;

/** Feedback is evaluation data; kept for a year, well beyond the conversations it rates. */
const FEEDBACK_TTL_SECONDS = 365 * 24 * 60 * 60;

type DocumentClient = import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

/**
 * The bot's own bookkeeping — which deliveries it has already handled, and how people rated its
 * answers — kept in the conversation table rather than tables of its own. Each lives under a
 * partition key prefix no conversation owner can have ("slack-event#", "slack-feedback#"), so it
 * never appears in a conversation query, and it expires through the same `expiresAt` TTL.
 *
 * With no table configured (a local run) both fall back to memory: deduplication then holds for
 * the life of the process, which is all a single local runner needs, and feedback is only logged.
 */
@Service()
export class SlackStateService {
    private client: Promise<DocumentClient> | undefined;
    private readonly seenLocally = new Map<string, number>();

    constructor(private readonly config: ConfigService) {}

    private async table(): Promise<{ tableName: string; client: DocumentClient } | undefined> {
        const table = await this.config.getConversationTableConfig().catch(() => undefined);
        if (!table) return undefined;

        this.client ??= (async () => {
            const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
            const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
            const clientConfig = await resolveAwsClientConfig(await this.config.getAWSCloudConfig());
            return DynamoDBDocumentClient.from(new DynamoDBClient({ ...clientConfig, region: table.region }), {
                marshallOptions: { removeUndefinedValues: true },
            });
        })().catch((err) => {
            this.client = undefined;
            throw err;
        });
        return { tableName: table.tableName, client: await this.client };
    }

    /**
     * True the first time a delivery is seen, false for every repeat. Slack re-delivers an event
     * it did not see acknowledged within three seconds — routine on a cold start — and each
     * repeat would otherwise be answered again.
     *
     * Fails open: if the table cannot be reached the event is handled. A rare duplicate answer is
     * a better failure than silently ignoring someone's question.
     */
    public async claimDelivery(key: string, nowMs: number = Date.now()): Promise<boolean> {
        let table: Awaited<ReturnType<SlackStateService["table"]>>;
        try {
            table = await this.table();
        } catch (err) {
            logger.warn(`Deduplication unavailable (${(err as Error).message}) — handling ${key} anyway.`);
            return true;
        }
        if (!table) return this.claimLocally(key, nowMs);

        const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
        try {
            await table.client.send(
                new PutCommand({
                    TableName: table.tableName,
                    Item: {
                        pk: `slack-event#${key}`,
                        sk: "delivery",
                        expiresAt: Math.floor(nowMs / 1000) + DEDUPE_TTL_SECONDS,
                    },
                    ConditionExpression: "attribute_not_exists(pk)",
                }),
            );
            return true;
        } catch (err) {
            if ((err as Error).name === "ConditionalCheckFailedException") return false;
            logger.warn(`Deduplication check failed (${(err as Error).message}) — handling ${key} anyway.`);
            return true;
        }
    }

    /**
     * Gives a claimed delivery back, when handling it failed before anything reached the user, so
     * Slack's retry of it is handled instead of dropped as a duplicate. Best effort: if this fails
     * too, the retry is dropped — the same outcome as not trying.
     */
    public async releaseDelivery(key: string): Promise<void> {
        this.seenLocally.delete(key);
        try {
            const table = await this.table();
            if (!table) return;
            const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
            await table.client.send(
                new DeleteCommand({ TableName: table.tableName, Key: { pk: `slack-event#${key}`, sk: "delivery" } }),
            );
        } catch (err) {
            logger.warn(`Could not release ${key} (${(err as Error).message}); a retry of it will be ignored.`);
        }
    }

    private claimLocally(key: string, nowMs: number): boolean {
        for (const [seenKey, expiresAt] of this.seenLocally) {
            if (expiresAt <= nowMs) this.seenLocally.delete(seenKey);
        }
        if (this.seenLocally.has(key)) return false;
        this.seenLocally.set(key, nowMs + DEDUPE_TTL_SECONDS * 1000);
        return true;
    }

    /**
     * Records a rating. One item per (answer, rater), so changing your mind overwrites rather
     * than double-counts. Keyed by workspace so a whole workspace's feedback is one Query.
     */
    public async recordFeedback(job: FeedbackJob, nowMs: number = Date.now()): Promise<void> {
        const table = await this.table();
        if (!table) {
            logger.info(
                `Feedback (${job.rating}) on ${job.channelId}/${job.messageTs} by ${job.userId} — no table, not stored.`,
            );
            return;
        }

        const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
        await table.client.send(
            new PutCommand({
                TableName: table.tableName,
                Item: {
                    pk: `slack-feedback#${job.teamId}`,
                    sk: `${job.channelId}#${job.messageTs}#${job.userId}`,
                    rating: job.rating,
                    raterId: job.userId,
                    ownerId: job.ownerId,
                    sessionId: job.sessionId,
                    channelId: job.channelId,
                    messageTs: job.messageTs,
                    createdAt: new Date(nowMs).toISOString(),
                    expiresAt: Math.floor(nowMs / 1000) + FEEDBACK_TTL_SECONDS,
                },
            }),
        );
    }
}
