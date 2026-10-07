import { getLogger } from "log4js";
import { Service } from "typedi";
import { SlackJob, SlackJobSchema, jobGroupKey } from "./slack-jobs";
import { SlackSettings } from "./slack-settings";

const logger = getLogger("SlackJobQueue");

/** Where the ingress hands work it must not do itself inside Slack's three-second window. */
export interface JobQueue {
    enqueue(job: SlackJob): Promise<void>;
}

export type JobHandler = (job: SlackJob) => Promise<void>;

/**
 * SQS FIFO. The message group is the thread, so questions in one thread are answered strictly in
 * order while threads run in parallel; the deduplication id is the job id, so a job enqueued
 * twice within SQS's five-minute window runs once.
 */
export class SqsJobQueue implements JobQueue {
    private client: import("@aws-sdk/client-sqs").SQSClient | undefined;

    constructor(private readonly queueUrl: string) {}

    public async enqueue(job: SlackJob): Promise<void> {
        const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
        this.client ??= new SQSClient({});
        await this.client.send(
            new SendMessageCommand({
                QueueUrl: this.queueUrl,
                MessageBody: JSON.stringify(SlackJobSchema.parse(job)),
                MessageGroupId: jobGroupKey(job),
                MessageDeduplicationId: job.id,
            }),
        );
    }
}

/**
 * Runs jobs in this process, for local development without a queue. Returns as soon as the job
 * is accepted — as SQS would — and keeps the same ordering guarantee: one job at a time per
 * thread, threads in parallel.
 */
export class InProcessJobQueue implements JobQueue {
    private readonly tails = new Map<string, Promise<void>>();

    constructor(private readonly handler: JobHandler) {}

    public async enqueue(job: SlackJob): Promise<void> {
        const key = jobGroupKey(job);
        const run = (this.tails.get(key) ?? Promise.resolve())
            .then(() => this.handler(job))
            .catch((err) => logger.error(`Job ${job.id} failed: ${(err as Error).message}`))
            .finally(() => {
                if (this.tails.get(key) === run) this.tails.delete(key);
            });
        this.tails.set(key, run);
    }
}

/**
 * Chooses the queue: SQS when SLACK_JOB_QUEUE_URL is set (AWS), otherwise in-process, which the
 * local runner enables by handing over the worker. Not injected with the worker directly: the
 * ingress Lambda would then load the whole answering stack — LangChain and every model SDK — on
 * a cold start that has three seconds to reply to Slack.
 */
@Service()
export class JobQueueProvider {
    private queue: JobQueue | undefined;
    private inProcessHandler: JobHandler | undefined;

    constructor(private readonly settings: SlackSettings) {}

    public runInProcess(handler: JobHandler): void {
        this.inProcessHandler = handler;
        this.queue = undefined;
    }

    public get(): JobQueue {
        if (this.queue) return this.queue;

        const { jobQueueUrl } = this.settings.get();
        if (jobQueueUrl) {
            this.queue = new SqsJobQueue(jobQueueUrl);
        } else if (this.inProcessHandler) {
            this.queue = new InProcessJobQueue(this.inProcessHandler);
        } else {
            throw new Error("SLACK_JOB_QUEUE_URL is not set, so there is nowhere to send questions to be answered.");
        }
        return this.queue;
    }
}
