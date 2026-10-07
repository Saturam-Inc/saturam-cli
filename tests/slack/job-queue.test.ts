import { InProcessJobQueue, JobQueueProvider, SqsJobQueue } from "../../src/slack/job-queue";
import { QuestionJob } from "../../src/slack/slack-jobs";

const job = (id: string, threadTs: string): QuestionJob => ({
    kind: "question",
    id,
    teamId: "T1",
    channelId: "C1",
    userId: "U1",
    threadTs,
    question: "q",
    source: "mention",
    placeholderTs: "9.9",
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("InProcessJobQueue", () => {
    it("returns before the job has run, as a real queue would", async () => {
        let release!: () => void;
        const handler = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
        await new InProcessJobQueue(handler).enqueue(job("a", "1.1"));
        await tick();
        expect(handler).toHaveBeenCalledTimes(1);
        release();
    });

    it("runs one thread's jobs in order, one at a time", async () => {
        const order: string[] = [];
        const releases: Array<() => void> = [];
        const queue = new InProcessJobQueue(
            (j) =>
                new Promise<void>((resolve) => {
                    order.push(`start ${j.id}`);
                    releases.push(() => {
                        order.push(`end ${j.id}`);
                        resolve();
                    });
                }),
        );

        await queue.enqueue(job("first", "1.1"));
        await queue.enqueue(job("second", "1.1"));
        await tick();
        expect(order).toEqual(["start first"]);

        releases[0]();
        await tick();
        await tick();
        expect(order).toEqual(["start first", "end first", "start second"]);
        releases[1]();
    });

    it("runs different threads in parallel", async () => {
        const started: string[] = [];
        const queue = new InProcessJobQueue((j) => {
            started.push(j.id);
            return new Promise<void>(() => undefined);
        });

        await queue.enqueue(job("a", "1.1"));
        await queue.enqueue(job("b", "2.2"));
        await tick();
        expect(started).toEqual(["a", "b"]);
    });

    it("keeps going after a job fails", async () => {
        const handler = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
        const queue = new InProcessJobQueue(handler);

        await queue.enqueue(job("a", "1.1"));
        await queue.enqueue(job("b", "1.1"));
        await tick();
        await tick();
        expect(handler).toHaveBeenCalledTimes(2);
    });
});

describe("JobQueueProvider", () => {
    const settings = (jobQueueUrl?: string) => ({ get: () => ({ jobQueueUrl }) }) as any;

    it("uses SQS when a queue URL is configured", () => {
        expect(new JobQueueProvider(settings("https://sqs/q.fifo")).get()).toBeInstanceOf(SqsJobQueue);
    });

    it("runs in-process when the local runner hands over a worker", () => {
        const provider = new JobQueueProvider(settings());
        provider.runInProcess(jest.fn());
        expect(provider.get()).toBeInstanceOf(InProcessJobQueue);
    });

    it("fails clearly when there is neither", () => {
        expect(() => new JobQueueProvider(settings()).get()).toThrow("SLACK_JOB_QUEUE_URL");
    });
});
