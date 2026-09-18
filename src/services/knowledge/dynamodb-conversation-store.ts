import { getLogger } from "log4js";
import { Service } from "typedi";
import { resolveAwsClientConfig } from "../../integrations/aws/utils/aws-credentials.util";
import { ConfigService } from "../config-service";
import { ChatSession, ChatTurn, MAX_RETAINED_TURNS, QuestionIntent, SessionDigest } from "./chat-session.model";
import { ConversationStore, InMemoryConversationStore } from "./conversation-store";
import { SessionRef } from "./session-identity";

const logger = getLogger("DynamoConversationStore");

const SESSION_SORT_PREFIX = "session#";

/** Bounded so a pathological collision loop cannot hang the answer that produced the turn. */
const APPEND_MAX_ATTEMPTS = 5;

/** Items scanned when listing an owner's recent sessions. */
const RECENT_SESSION_SCAN_LIMIT = 200;

/**
 * Sort keys are "session#<id>#meta" and "session#<id>#turn#<index>". Session ids sort
 * chronologically, so the newest session is simply the largest sort key under the owner — that is
 * what makes "continue the conversation already in progress" one descending query.
 */
function sessionPrefix(sessionId: string): string {
    return `${SESSION_SORT_PREFIX}${sessionId}#`;
}

function metaSortKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}meta`;
}

/** Zero-pads the index so lexicographic ordering matches numeric ordering past turn 9. */
function turnSortKey(sessionId: string, index: number): string {
    return `${sessionPrefix(sessionId)}turn#${String(index).padStart(6, "0")}`;
}

function turnPrefix(sessionId: string): string {
    return `${sessionPrefix(sessionId)}turn#`;
}

/** Recovers the session id from any of that session's sort keys. */
export function sessionIdFromSortKey(sk: string): string | undefined {
    const match = /^session#([^#]+)#/.exec(sk);
    return match?.[1];
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

    /**
     * Set after the first failed call. Losing the table must not silently disable conversation
     * memory altogether: without this the flow would start a fresh session on every question, so
     * follow-ups answer as if nothing had been said. Once degraded, the in-memory store takes over
     * for the rest of the process, so context still works within the session.
     */
    private degraded = false;

    constructor(
        private readonly config: ConfigService,
        private readonly fallback: InMemoryConversationStore,
    ) {}

    /** Records the first failure, explains it once, and hands over to the in-memory store. */
    private degrade(err: unknown): void {
        if (this.degraded) return;
        this.degraded = true;
        logger.warn(
            `Conversation history is not reachable, so this session is keeping history in memory only: ${(err as Error).message}`,
        );
        logger.warn(
            "History will not carry across runs until this is fixed — check the table name, region, and that the IAM identity has dynamodb:Query, PutItem and UpdateItem on it.",
        );
    }

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

    /** Session ids for this owner, newest first — the newest is the conversation to continue. */
    public async findRecentSessionIds(ownerId: string, limit: number): Promise<string[]> {
        if (this.degraded) return this.fallback.findRecentSessionIds(ownerId, limit);

        try {
            const { tableName, region } = await this.requireTable();
            const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            // Descending over the owner's items: because session ids sort chronologically, the
            // first distinct session encountered is the most recent one.
            const response = await client.send(
                new QueryCommand({
                    TableName: tableName,
                    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
                    ExpressionAttributeValues: { ":pk": ownerId, ":prefix": SESSION_SORT_PREFIX },
                    ProjectionExpression: "sk",
                    ScanIndexForward: false,
                    Limit: RECENT_SESSION_SCAN_LIMIT,
                }),
            );

            const seen: string[] = [];
            for (const item of response.Items ?? []) {
                const sessionId = typeof item.sk === "string" ? sessionIdFromSortKey(item.sk) : undefined;
                if (sessionId && !seen.includes(sessionId)) {
                    seen.push(sessionId);
                    if (seen.length >= limit) break;
                }
            }
            return seen;
        } catch (err) {
            this.degrade(err);
            return this.fallback.findRecentSessionIds(ownerId, limit);
        }
    }

    public async load(ref: SessionRef): Promise<ChatSession> {
        if (this.degraded) return this.fallback.load(ref);

        try {
            const { tableName, region } = await this.requireTable();
            const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            // Two queries rather than one. "meta" sorts before every "turn#..." key, so a single
            // limited query can stop before reaching one of them — silently losing either the
            // turns or the active project. Both calls use Query, so no extra IAM action is needed.
            const [turnPage, metaPage] = await Promise.all([
                client.send(
                    new QueryCommand({
                        TableName: tableName,
                        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
                        ExpressionAttributeValues: { ":pk": ref.ownerId, ":prefix": turnPrefix(ref.sessionId) },
                        ScanIndexForward: false,
                        Limit: MAX_RETAINED_TURNS,
                    }),
                ),
                client.send(
                    new QueryCommand({
                        TableName: tableName,
                        KeyConditionExpression: "pk = :pk AND sk = :sk",
                        ExpressionAttributeValues: { ":pk": ref.ownerId, ":sk": metaSortKey(ref.sessionId) },
                        Limit: 1,
                    }),
                ),
            ]);

            const meta = metaPage.Items?.[0];
            const turns = (turnPage.Items ?? [])
                .map((item) => this.toTurn(item))
                .sort((a, b) => a.index - b.index)
                .slice(-MAX_RETAINED_TURNS);

            return {
                sessionId: ref.sessionId,
                turns,
                activeProject: typeof meta?.activeProject === "string" ? meta.activeProject : undefined,
                digest: (meta?.digest as SessionDigest | undefined) ?? undefined,
            };
        } catch (err) {
            this.degrade(err);
            return this.fallback.load(ref);
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

    /**
     * Appends a turn, never overwriting one that already exists at that index.
     *
     * The index comes from the caller's view of the conversation, so two terminals sharing a
     * session can compute the same one. A plain put would let the later write silently replace the
     * earlier answer. The conditional write turns that into a detectable collision, and the retry
     * places the turn after whatever landed first.
     */
    public async appendTurn(ref: SessionRef, turn: ChatTurn): Promise<void> {
        if (this.degraded) return this.fallback.appendTurn(ref, turn);

        try {
            const { tableName, region, ttlDays } = await this.requireTable();
            const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            let index = turn.index;
            for (let attempt = 0; attempt < APPEND_MAX_ATTEMPTS; attempt += 1) {
                try {
                    await client.send(
                        new PutCommand({
                            TableName: tableName,
                            Item: {
                                pk: ref.ownerId,
                                sk: turnSortKey(ref.sessionId, index),
                                sessionId: ref.sessionId,
                                ...turn,
                                index,
                                expiresAt: this.expiresAt(ttlDays),
                            },
                            ConditionExpression: "attribute_not_exists(sk)",
                        }),
                    );
                    return;
                } catch (err) {
                    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
                    index = (await this.highestTurnIndex(ref, tableName, region)) + 1;
                    logger.debug(`Turn index taken by a concurrent write — retrying at ${index}.`);
                }
            }

            logger.warn(`Could not find a free turn index after ${APPEND_MAX_ATTEMPTS} attempts — turn not stored.`);
        } catch (err) {
            this.degrade(err);
            await this.fallback.appendTurn(ref, turn);
        }
    }

    /** Highest turn index currently stored for a session, or -1 when it has no turns yet. */
    private async highestTurnIndex(ref: SessionRef, tableName: string, region: string): Promise<number> {
        const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
        const client = await this.getClient(region);
        const newest = await client.send(
            new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
                ExpressionAttributeValues: { ":pk": ref.ownerId, ":prefix": turnPrefix(ref.sessionId) },
                ScanIndexForward: false,
                Limit: 1,
            }),
        );
        const top = newest.Items?.[0];
        return typeof top?.index === "number" ? top.index : -1;
    }

    public async saveDigest(ref: SessionRef, digest: SessionDigest): Promise<void> {
        await this.updateMeta(ref, "digest", digest);
    }

    public async saveActiveProject(ref: SessionRef, project: string | undefined): Promise<void> {
        await this.updateMeta(ref, "activeProject", project);
    }

    /**
     * Writes one attribute on the session's meta item, creating it if absent. An update rather
     * than a put, so the digest and the active project do not clobber one another.
     */
    private async updateMeta(ref: SessionRef, attribute: "digest" | "activeProject", value: unknown): Promise<void> {
        if (this.degraded) return this.writeMetaToFallback(ref, attribute, value);

        try {
            const { tableName, region, ttlDays } = await this.requireTable();
            const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
            const client = await this.getClient(region);

            await client.send(
                new UpdateCommand({
                    TableName: tableName,
                    Key: { pk: ref.ownerId, sk: metaSortKey(ref.sessionId) },
                    UpdateExpression: "SET #attr = :value, sessionId = :sessionId, expiresAt = :expiresAt",
                    ExpressionAttributeNames: { "#attr": attribute },
                    ExpressionAttributeValues: {
                        ":value": value ?? null,
                        ":sessionId": ref.sessionId,
                        ":expiresAt": this.expiresAt(ttlDays),
                    },
                }),
            );
        } catch (err) {
            this.degrade(err);
            await this.writeMetaToFallback(ref, attribute, value);
        }
    }

    private async writeMetaToFallback(
        ref: SessionRef,
        attribute: "digest" | "activeProject",
        value: unknown,
    ): Promise<void> {
        if (attribute === "digest") {
            await this.fallback.saveDigest(ref, value as SessionDigest);
        } else {
            await this.fallback.saveActiveProject(ref, value as string | undefined);
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
