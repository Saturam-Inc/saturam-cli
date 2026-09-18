import { getLogger } from "log4js";
import { Service } from "typedi";
import { resolveAwsClientConfig } from "../../integrations/aws/utils/aws-credentials.util";
import { ConfigService } from "../config-service";
import {
    ChatSession,
    ChatTurn,
    MAX_RETAINED_TURNS,
    QuestionIntent,
    SessionDigest,
    createEmptySession,
} from "./chat-session.model";
import { ConversationStore, InMemoryConversationStore } from "./conversation-store";

const logger = getLogger("DynamoConversationStore");

const META_SORT_KEY = "meta";
const TURN_SORT_PREFIX = "turn#";

/** Zero-pads a turn index so lexicographic sort-key ordering matches numeric ordering. */
function turnSortKey(index: number): string {
    return `${TURN_SORT_PREFIX}${String(index).padStart(6, "0")}`;
}

function partitionKey(sessionId: string): string {
    return `session#${sessionId}`;
}

/**
 * DynamoDB-backed conversation history.
 *
 * One item per turn plus one `meta` item per session, rather than a single item holding the
 * whole conversation: twenty mentor-length answers can approach DynamoDB's 400KB item limit,
 * and per-turn items make the recent-turns read a bounded Query instead of a full-session read.
 *
 * Every method degrades to a warning rather than throwing. Losing conversation history makes
 * answers less contextual, but it should never take down the answering flow itself.
 */
@Service()
export class DynamoDbConversationStore implements ConversationStore {
    private client: import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient | undefined;

    constructor(private readonly config: ConfigService) {}

    private async getClient(region: string): Promise<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient> {
        if (this.client) return this.client;

        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
        const cloudConfig = await this.config.getAWSCloudConfig();
        const clientConfig = await resolveAwsClientConfig(cloudConfig);

        this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ ...clientConfig, region }), {
            marshallOptions: { removeUndefinedValues: true },
        });
        return this.client;
    }

    private async requireTable(): Promise<{ tableName: string; region: string; ttlDays: number }> {
        const table = await this.config.getConversationTableConfig();
        if (!table) {
            throw new Error("No DynamoDB conversation table is configured.");
        }
        return table;
    }

    private expiresAt(ttlDays: number): number {
        return Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
    }

    public async load(sessionId: string): Promise<ChatSession> {
        try {
            const { tableName, region } = await this.requireTable();
            const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            // Descending so the newest MAX_RETAINED_TURNS come back regardless of session length,
            // then reversed into chronological order for the callers that build message pairs.
            const response = await client.send(
                new QueryCommand({
                    TableName: tableName,
                    KeyConditionExpression: "pk = :pk",
                    ExpressionAttributeValues: { ":pk": partitionKey(sessionId) },
                    ScanIndexForward: false,
                    Limit: MAX_RETAINED_TURNS + 1,
                }),
            );

            const items = response.Items ?? [];
            const meta = items.find((item) => item.sk === META_SORT_KEY);
            const turns = items
                .filter((item) => typeof item.sk === "string" && item.sk.startsWith(TURN_SORT_PREFIX))
                .map((item) => this.toTurn(item))
                .sort((a, b) => a.index - b.index)
                .slice(-MAX_RETAINED_TURNS);

            return {
                sessionId,
                turns,
                activeProject: typeof meta?.activeProject === "string" ? meta.activeProject : undefined,
                digest: (meta?.digest as SessionDigest | undefined) ?? undefined,
            };
        } catch (err) {
            logger.warn(`Could not load conversation history: ${(err as Error).message}. Starting a fresh session.`);
            return createEmptySession(sessionId);
        }
    }

    private toTurn(item: Record<string, unknown>): ChatTurn {
        return {
            index: typeof item.index === "number" ? item.index : 0,
            question: String(item.question ?? ""),
            answer: String(item.answer ?? ""),
            answerGist: String(item.answerGist ?? ""),
            intent: (item.intent as QuestionIntent) ?? QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: typeof item.resolvedProject === "string" ? item.resolvedProject : undefined,
            retrievedChunkIds: Array.isArray(item.retrievedChunkIds) ? (item.retrievedChunkIds as string[]) : [],
            createdAt: String(item.createdAt ?? new Date().toISOString()),
        };
    }

    public async appendTurn(sessionId: string, turn: ChatTurn): Promise<void> {
        try {
            const { tableName, region, ttlDays } = await this.requireTable();
            const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            await client.send(
                new PutCommand({
                    TableName: tableName,
                    Item: {
                        pk: partitionKey(sessionId),
                        sk: turnSortKey(turn.index),
                        ...turn,
                        expiresAt: this.expiresAt(ttlDays),
                    },
                }),
            );
        } catch (err) {
            logger.warn(`Could not persist conversation turn: ${(err as Error).message}`);
        }
    }

    public async saveDigest(sessionId: string, digest: SessionDigest): Promise<void> {
        await this.updateMeta(sessionId, "digest", digest);
    }

    public async saveActiveProject(sessionId: string, project: string | undefined): Promise<void> {
        await this.updateMeta(sessionId, "activeProject", project);
    }

    /**
     * Writes one attribute on the session's `meta` item, creating it if absent. An update (rather
     * than a put) so the digest and the active project do not clobber one another.
     */
    private async updateMeta(sessionId: string, attribute: "digest" | "activeProject", value: unknown): Promise<void> {
        try {
            const { tableName, region, ttlDays } = await this.requireTable();
            const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            await client.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { pk: partitionKey(sessionId), sk: META_SORT_KEY },
                    UpdateExpression: "SET #attr = :value, expiresAt = :expiresAt",
                    ExpressionAttributeNames: { "#attr": attribute },
                    ExpressionAttributeValues: { ":value": value ?? null, ":expiresAt": this.expiresAt(ttlDays) },
                }),
            );
        } catch (err) {
            logger.warn(`Could not persist session ${attribute}: ${(err as Error).message}`);
        }
    }
}

/**
 * Chooses the conversation store for this run: DynamoDB when a table is configured, otherwise
 * the in-memory store. Resolved once per process, since the answer depends only on config.
 */
@Service()
export class ConversationStoreProvider {
    private resolved: ConversationStore | undefined;

    constructor(
        private readonly config: ConfigService,
        private readonly dynamo: DynamoDbConversationStore,
        private readonly memory: InMemoryConversationStore,
    ) {}

    public async get(): Promise<ConversationStore> {
        if (this.resolved) return this.resolved;

        const table = await this.config.getConversationTableConfig().catch(() => undefined);
        if (table) {
            logger.debug(`Using DynamoDB conversation history (table: ${table.tableName}).`);
            this.resolved = this.dynamo;
        } else {
            logger.debug("No conversation table configured — using in-memory history for this session.");
            this.resolved = this.memory;
        }
        return this.resolved;
    }
}
