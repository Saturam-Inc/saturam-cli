import { RetryableJobError } from "../../src/slack/slack-worker.service";

const process = jest.fn();
const send = jest.fn().mockResolvedValue({});

jest.mock("../../src/slack/slack-container", () => {
    const { SlackWorkerService } = jest.requireActual("../../src/slack/slack-worker.service");
    const { SlackSettings } = jest.requireActual("../../src/slack/slack-settings");
    const { ConfigService } = jest.requireActual("../../src/services/config-service");
    return {
        getSlackContainer: () => ({
            get: (token: unknown) => {
                if (token === SlackWorkerService) return { process };
                if (token === SlackSettings)
                    return { get: () => ({ workerMaxAttempts: 2, jobQueueUrl: "https://sqs/q.fifo" }) };
                if (token === ConfigService)
                    return { getModel: async () => "anthropic.claude-sonnet-4-5-20250929-v1:0" };
                throw new Error("unexpected token");
            },
        }),
    };
});
jest.mock("@aws-sdk/client-sqs", () => ({
    SQSClient: jest.fn(() => ({ send })),
    ChangeMessageVisibilityCommand: jest.fn((input) => ({ input })),
}));

import { handler } from "../../src/entrypoints/slack-worker.lambda";

const job = (id: string) =>
    JSON.stringify({
        kind: "question",
        id,
        teamId: "T1",
        channelId: "C1",
        userId: "U1",
        threadTs: "1.1",
        question: "q",
        source: "mention",
        placeholderTs: "2.2",
    });

const record = (messageId: string, body: string, receiveCount = "1") => ({
    messageId,
    receiptHandle: `rh-${messageId}`,
    body,
    attributes: { ApproximateReceiveCount: receiveCount },
});

describe("slack worker Lambda handler", () => {
    beforeEach(() => {
        process.mockReset().mockResolvedValue(undefined);
        send.mockClear();
    });

    it("processes every record and reports no failures on success", async () => {
        const result = await handler({ Records: [record("m1", job("a")), record("m2", job("b"))] });
        expect(result.batchItemFailures).toEqual([]);
        expect(process).toHaveBeenCalledTimes(2);
    });

    it("passes the receive count through as the attempt number", async () => {
        await handler({ Records: [record("m1", job("a"), "2")] });
        expect(process).toHaveBeenCalledWith(expect.anything(), { number: 2, max: 2 });
    });

    it("fails a malformed message so it reaches the dead-letter queue", async () => {
        const result = await handler({ Records: [record("m1", "{not json")] });
        expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
        expect(process).not.toHaveBeenCalled();
    });

    it("holds back the rest of the batch behind a failure, preserving FIFO order", async () => {
        process.mockRejectedValueOnce(new RetryableJobError("retry"));
        const result = await handler({ Records: [record("m1", job("a")), record("m2", job("b"))] });

        expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
        expect(process).toHaveBeenCalledTimes(1);
    });

    it("brings a retryable failure back quickly instead of after the full visibility timeout", async () => {
        process.mockRejectedValueOnce(new RetryableJobError("retry"));
        await handler({ Records: [record("m1", job("a"))] });

        expect(send).toHaveBeenCalledWith({
            input: { QueueUrl: "https://sqs/q.fifo", ReceiptHandle: "rh-m1", VisibilityTimeout: 15 },
        });
    });
});
