import { QuestionIntent } from "../../../src/services/knowledge/chat-session.model";

const sendMock = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({ name: "ddb" })),
}));

jest.mock("@aws-sdk/lib-dynamodb", () => {
    function makeCommand(type: string) {
        return jest.fn().mockImplementation(function (this: any, input: any) {
            this.input = input;
            this.type = type;
        });
    }
    return {
        DynamoDBDocumentClient: { from: jest.fn(() => ({ send: sendMock })) },
        QueryCommand: makeCommand("Query"),
        PutCommand: makeCommand("Put"),
        UpdateCommand: makeCommand("Update"),
    };
});

jest.mock("../../../src/integrations/aws/utils/aws-credentials.util", () => ({
    resolveAwsClientConfig: jest.fn().mockResolvedValue({ credentials: {} }),
}));

import { DynamoDbConversationStore } from "../../../src/services/knowledge/dynamodb-conversation-store";
import { InMemoryConversationStore } from "../../../src/services/knowledge/conversation-store";
import { SessionRef } from "../../../src/services/knowledge/session-identity";

const OWNER = "owner#vinoth#ubuntu";
const ref = (sessionId: string): SessionRef => ({ ownerId: OWNER, sessionId });

function turn(index: number) {
    return {
        index,
        question: `q${index}`,
        answer: `a${index}`,
        answerGist: `g${index}`,
        intent: QuestionIntent.PROJECT_KNOWLEDGE,
        retrievedChunkIds: [],
        createdAt: "2026-09-18T00:00:00Z",
    };
}

describe("DynamoDbConversationStore", () => {
    let config: any;
    let fallback: InMemoryConversationStore;
    let store: DynamoDbConversationStore;

    beforeEach(() => {
        jest.clearAllMocks();
        sendMock.mockResolvedValue({ Items: [] });
        config = {
            getConversationTableConfig: jest
                .fn()
                .mockResolvedValue({ tableName: "sateng-conversations", region: "ap-south-1", ttlDays: 90 }),
            getAWSCloudConfig: jest.fn().mockResolvedValue({ awsRegion: "ap-south-1" }),
        };
        fallback = new InMemoryConversationStore();
        store = new DynamoDbConversationStore(config, fallback);
    });

    it("writes a turn under a session-partitioned, zero-padded sort key", async () => {
        await store.appendTurn(ref("s1"), turn(7));

        const { input } = sendMock.mock.calls[0][0];
        expect(input.TableName).toBe("sateng-conversations");
        expect(input.Item.pk).toBe(OWNER);
        // Zero-padded so lexicographic sort-key ordering matches numeric ordering past turn 9.
        expect(input.Item.sk).toBe("session#s1#turn#000007");
        expect(input.Item.answerGist).toBe("g7");
    });

    it("refuses to overwrite a turn another process already wrote", async () => {
        await store.appendTurn(ref("s1"), turn(0));

        const put = sendMock.mock.calls[0][0].input;
        // Without this condition a second process computing the same index silently replaces the
        // first process's answer.
        expect(put.ConditionExpression).toBe("attribute_not_exists(sk)");
    });

    it("places the turn after the colliding one instead of losing it", async () => {
        const collision = Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        sendMock
            .mockRejectedValueOnce(collision)
            .mockResolvedValueOnce({ Items: [{ sk: "session#s1#turn#000007", index: 7 }] })
            .mockResolvedValueOnce({});

        await store.appendTurn(ref("s1"), turn(5));

        const retry = sendMock.mock.calls[2][0].input;
        expect(retry.Item.sk).toBe("session#s1#turn#000008");
        expect(retry.Item.index).toBe(8);
    });

    it("gives up after a bounded number of collisions rather than looping", async () => {
        const collision = Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        sendMock.mockImplementation((cmd: any) =>
            cmd.type === "Put"
                ? Promise.reject(collision)
                : Promise.resolve({ Items: [{ sk: "session#s1#turn#000000", index: 0 }] }),
        );

        await expect(store.appendTurn(ref("s1"), turn(0))).resolves.toBeUndefined();

        const puts = sendMock.mock.calls.filter((c: any) => c[0].type === "Put");
        expect(puts.length).toBeLessThanOrEqual(5);
    });

    it("stamps a TTL so sessions expire instead of accumulating forever", async () => {
        const before = Math.floor(Date.now() / 1000);
        await store.appendTurn(ref("s1"), turn(0));

        const { input } = sendMock.mock.calls[0][0];
        expect(input.Item.expiresAt).toBeGreaterThanOrEqual(before + 90 * 24 * 60 * 60);
    });

    it("fetches turns and the meta item separately, so meta is never cut off", async () => {
        // The bug this guards: "meta" sorts after every "turn#..." key descending, so one limited
        // query stopped before reaching it once a session passed the limit — silently dropping the
        // active project and the digest.
        sendMock
            .mockResolvedValueOnce({
                Items: [
                    { sk: "session#s1#turn#000002", ...turn(2) },
                    { sk: "session#s1#turn#000001", ...turn(1) },
                ],
            })
            .mockResolvedValueOnce({
                Items: [
                    {
                        sk: "meta",
                        activeProject: "smile",
                        digest: {
                            summary: "d",
                            projectsDiscussed: [],
                            jargonDefined: [],
                            questionsAsked: [],
                            coversUpToIndex: 1,
                        },
                    },
                ],
            });

        const session = await store.load(ref("s1"));

        const turnQuery = sendMock.mock.calls[0][0].input;
        const metaQuery = sendMock.mock.calls[1][0].input;
        expect(turnQuery.KeyConditionExpression).toBe("pk = :pk AND begins_with(sk, :prefix)");
        expect(turnQuery.ExpressionAttributeValues[":pk"]).toBe(OWNER);
        expect(turnQuery.ExpressionAttributeValues[":prefix"]).toBe("session#s1#turn#");
        expect(turnQuery.ScanIndexForward).toBe(false);
        expect(metaQuery.KeyConditionExpression).toBe("pk = :pk AND sk = :sk");
        expect(session.turns.map((t) => t.index)).toEqual([1, 2]);
        expect(session.activeProject).toBe("smile");
        expect(session.digest?.summary).toBe("d");
    });

    it("still returns the meta item on a session longer than the turn limit", async () => {
        const many = Array.from({ length: 25 }, (_, i) => ({
            sk: `session#s1#turn#${String(24 - i).padStart(6, "0")}`,
            ...turn(24 - i),
        }));
        sendMock
            .mockResolvedValueOnce({ Items: many.slice(0, 20) })
            .mockResolvedValueOnce({ Items: [{ sk: "session#s1#meta", activeProject: "mrf" }] });

        const session = await store.load(ref("s1"));

        expect(session.turns).toHaveLength(20);
        expect(session.activeProject).toBe("mrf");
    });

    it("updates the digest and active project separately so neither clobbers the other", async () => {
        await store.saveActiveProject(ref("s1"), "smile");
        await store.saveDigest(ref("s1"), {
            summary: "covered refunds",
            projectsDiscussed: ["smile"],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 2,
        });

        const first = sendMock.mock.calls[0][0].input;
        const second = sendMock.mock.calls[1][0].input;
        expect(first.Key).toEqual({ pk: OWNER, sk: "session#s1#meta" });
        expect(first.ExpressionAttributeNames).toEqual({ "#attr": "activeProject" });
        expect(second.ExpressionAttributeNames).toEqual({ "#attr": "digest" });
        expect(second.ExpressionAttributeValues[":value"]).toMatchObject({ summary: "covered refunds" });
    });

    it("does not take down the answering flow when the table is unreachable", async () => {
        sendMock.mockRejectedValueOnce(Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }));

        const session = await store.load(ref("s1"));

        expect(session).toEqual({ sessionId: "s1", turns: [] });
    });

    it("keeps history in memory after a failure, so context survives within the session", async () => {
        // The bug this guards: every turn used to start a fresh session, so a follow-up was
        // answered as if nothing had been said before it.
        sendMock.mockRejectedValue(Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }));

        await store.load(ref("s1"));
        await store.appendTurn(ref("s1"), turn(0));
        await store.saveActiveProject(ref("s1"), "mrf");
        const session = await store.load(ref("s1"));

        expect(session.turns.map((t) => t.index)).toEqual([0]);
        expect(session.activeProject).toBe("mrf");
    });

    it("stops calling DynamoDB once degraded, instead of retrying on every question", async () => {
        sendMock.mockRejectedValue(new Error("not authorized"));

        await store.load(ref("s1"));
        const callsAfterFirstFailure = sendMock.mock.calls.length;
        await store.appendTurn(ref("s1"), turn(0));
        await store.saveActiveProject(ref("s1"), "mrf");

        expect(sendMock.mock.calls.length).toBe(callsAfterFirstFailure);
    });

    it("preserves the digest through the fallback as well", async () => {
        sendMock.mockRejectedValue(new Error("not authorized"));
        await store.load(ref("s1"));

        await store.saveDigest(ref("s1"), {
            summary: "covered mrf",
            projectsDiscussed: ["mrf"],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 1,
        });

        expect((await store.load(ref("s1"))).digest?.summary).toBe("covered mrf");
    });

    it("swallows write failures rather than failing the question that produced them", async () => {
        sendMock.mockRejectedValue(new Error("throughput exceeded"));

        await expect(store.appendTurn(ref("s1"), turn(0))).resolves.toBeUndefined();
        await expect(
            store.saveDigest(ref("s1"), {
                summary: "",
                projectsDiscussed: [],
                jargonDefined: [],
                questionsAsked: [],
                coversUpToIndex: 0,
            }),
        ).resolves.toBeUndefined();
    });

    it("falls back to memory when no table is configured", async () => {
        config.getConversationTableConfig.mockResolvedValue(undefined);

        await store.load(ref("s1"));
        await store.appendTurn(ref("s1"), turn(0));

        expect(sendMock).not.toHaveBeenCalled();
        expect((await store.load(ref("s1"))).turns).toHaveLength(1);
    });
});
