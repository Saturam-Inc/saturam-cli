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
        store = new DynamoDbConversationStore(config);
    });

    it("writes a turn under a session-partitioned, zero-padded sort key", async () => {
        await store.appendTurn("s1", turn(7));

        const { input } = sendMock.mock.calls[0][0];
        expect(input.TableName).toBe("sateng-conversations");
        expect(input.Item.pk).toBe("session#s1");
        // Zero-padded so lexicographic sort-key ordering matches numeric ordering past turn 9.
        expect(input.Item.sk).toBe("turn#000007");
        expect(input.Item.answerGist).toBe("g7");
    });

    it("stamps a TTL so sessions expire instead of accumulating forever", async () => {
        const before = Math.floor(Date.now() / 1000);
        await store.appendTurn("s1", turn(0));

        const { input } = sendMock.mock.calls[0][0];
        expect(input.Item.expiresAt).toBeGreaterThanOrEqual(before + 90 * 24 * 60 * 60);
    });

    it("queries newest-first and returns turns in chronological order", async () => {
        sendMock.mockResolvedValueOnce({
            Items: [
                { sk: "turn#000002", ...turn(2) },
                { sk: "turn#000001", ...turn(1) },
                { sk: "meta", activeProject: "smile", digest: { summary: "d", projectsDiscussed: [], jargonDefined: [], questionsAsked: [], coversUpToIndex: 1 } },
            ],
        });

        const session = await store.load("s1");

        const { input } = sendMock.mock.calls[0][0];
        expect(input.KeyConditionExpression).toBe("pk = :pk");
        expect(input.ExpressionAttributeValues).toEqual({ ":pk": "session#s1" });
        expect(input.ScanIndexForward).toBe(false);
        expect(session.turns.map((t) => t.index)).toEqual([1, 2]);
        expect(session.activeProject).toBe("smile");
        expect(session.digest?.summary).toBe("d");
    });

    it("updates the digest and active project separately so neither clobbers the other", async () => {
        await store.saveActiveProject("s1", "smile");
        await store.saveDigest("s1", {
            summary: "covered refunds",
            projectsDiscussed: ["smile"],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 2,
        });

        const first = sendMock.mock.calls[0][0].input;
        const second = sendMock.mock.calls[1][0].input;
        expect(first.Key).toEqual({ pk: "session#s1", sk: "meta" });
        expect(first.ExpressionAttributeNames).toEqual({ "#attr": "activeProject" });
        expect(second.ExpressionAttributeNames).toEqual({ "#attr": "digest" });
        expect(second.ExpressionAttributeValues[":value"]).toMatchObject({ summary: "covered refunds" });
    });

    it("returns an empty session instead of throwing when the table is unreachable", async () => {
        // The IAM user may have no DynamoDB permissions, or the table may not exist. Losing
        // history must never take down the answering flow.
        sendMock.mockRejectedValueOnce(Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }));

        const session = await store.load("s1");

        expect(session).toEqual({ sessionId: "s1", turns: [] });
    });

    it("swallows write failures rather than failing the question that produced them", async () => {
        sendMock.mockRejectedValue(new Error("throughput exceeded"));

        await expect(store.appendTurn("s1", turn(0))).resolves.toBeUndefined();
        await expect(store.saveDigest("s1", {
            summary: "", projectsDiscussed: [], jargonDefined: [], questionsAsked: [], coversUpToIndex: 0,
        })).resolves.toBeUndefined();
    });

    it("degrades to an empty session when no table is configured", async () => {
        config.getConversationTableConfig.mockResolvedValue(undefined);

        const session = await store.load("s1");

        expect(session).toEqual({ sessionId: "s1", turns: [] });
        expect(sendMock).not.toHaveBeenCalled();
    });
});
