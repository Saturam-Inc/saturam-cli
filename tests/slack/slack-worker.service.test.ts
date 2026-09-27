import { RetryableJobError, SlackWorkerService } from "../../src/slack/slack-worker.service";
import { QuestionJob } from "../../src/slack/slack-jobs";

const job: QuestionJob = {
    kind: "question",
    id: "event:Ev1",
    teamId: "T1",
    channelId: "C1",
    userId: "U1",
    threadTs: "1727086500.000100",
    question: "how does the scheduler work?",
    source: "mention",
    placeholderTs: "1727086501.000200",
};

describe("SlackWorkerService", () => {
    let answerFlow: any;
    let gateway: any;
    let state: any;
    let worker: SlackWorkerService;

    beforeEach(() => {
        answerFlow = {
            ask: jest.fn().mockResolvedValue({
                answer: "It reads the jobs table.",
                chunks: [],
                followUps: [],
                project: undefined,
            }),
        };
        gateway = {
            update: jest.fn().mockResolvedValue(undefined),
            postInThread: jest.fn().mockResolvedValue("x"),
            whisper: jest.fn().mockResolvedValue(undefined),
        };
        state = { recordFeedback: jest.fn().mockResolvedValue(undefined) };
        worker = new SlackWorkerService(answerFlow, gateway, state);
    });

    it("answers in the thread's conversation and replaces the placeholder", async () => {
        await worker.process(job);

        expect(answerFlow.ask).toHaveBeenCalledWith("how does the scheduler work?", {
            ownerId: "slack#T1#U1",
            sessionId: "20240923T101500Z-C1-000100",
        });
        expect(gateway.update).toHaveBeenCalledWith(
            "C1",
            job.placeholderTs,
            expect.objectContaining({ text: "It reads the jobs table." }),
        );
    });

    it("asks for a retry, and says so, when a non-final attempt fails", async () => {
        answerFlow.ask.mockRejectedValue(new Error("ThrottlingException"));

        await expect(worker.process(job, { number: 1, max: 2 })).rejects.toBeInstanceOf(RetryableJobError);
        expect(gateway.update).toHaveBeenCalledWith(
            "C1",
            job.placeholderTs,
            expect.objectContaining({ text: "Still working…" }),
        );
    });

    it("apologises on the final attempt instead of throwing into the dead-letter queue", async () => {
        answerFlow.ask.mockRejectedValue(new Error("ThrottlingException"));

        await expect(worker.process(job, { number: 2, max: 2 })).resolves.toBeUndefined();
        const message = gateway.update.mock.calls[0][2];
        expect(message.text).toBe("Sorry — I couldn't answer that just now.");
        expect(JSON.stringify(message.blocks)).not.toContain("ThrottlingException");
    });

    it("posts the answer as a new reply when the placeholder cannot be updated, and does not retry", async () => {
        gateway.update.mockRejectedValue(new Error("message_not_found"));

        await expect(worker.process(job)).resolves.toBeUndefined();
        expect(gateway.postInThread).toHaveBeenCalledWith(
            "C1",
            job.threadTs,
            expect.objectContaining({ text: "It reads the jobs table." }),
        );
        expect(answerFlow.ask).toHaveBeenCalledTimes(1);
    });

    it("records feedback and thanks the rater privately", async () => {
        const feedback = {
            kind: "feedback" as const,
            id: "action:1.1:U2",
            teamId: "T1",
            channelId: "C1",
            userId: "U2",
            threadTs: job.threadTs,
            messageTs: job.placeholderTs,
            ownerId: "slack#T1#U1",
            sessionId: "s",
            rating: "up" as const,
        };

        await worker.process(feedback);

        expect(state.recordFeedback).toHaveBeenCalledWith(feedback);
        expect(gateway.whisper).toHaveBeenCalledWith("C1", "U2", expect.stringContaining("Thanks"), job.threadTs);
        expect(answerFlow.ask).not.toHaveBeenCalled();
    });
});
