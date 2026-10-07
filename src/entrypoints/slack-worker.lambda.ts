import "reflect-metadata";

import { getLogger } from "log4js";
import { SlackJobSchema } from "../slack/slack-jobs";
import { SlackSettings } from "../slack/slack-settings";
import { RetryableJobError, SlackWorkerService } from "../slack/slack-worker.service";
import { getSlackContainer } from "../slack/slack-container";
import { loadLlmCredentials, prepareLambdaEnvironment, reportModelMisconfiguration } from "../slack/lambda-runtime";
import { configureServiceLogging } from "../utils/logging-utils";

prepareLambdaEnvironment();
configureServiceLogging();
const logger = getLogger("SlackWorkerLambda");

/**
 * How soon a failed attempt is retried. Without this, SQS redelivers only when the message's
 * visibility timeout runs out — minutes, with the user watching "trying again…" the whole time.
 */
const RETRY_DELAY_SECONDS = 15;

/** The parts of an SQS event this handler reads. */
interface SqsEvent {
    Records: Array<{
        messageId: string;
        receiptHandle: string;
        body: string;
        attributes?: { ApproximateReceiveCount?: string };
    }>;
}

/** Partial batch response — requires "Report batch item failures" on the event source mapping. */
interface SqsBatchResponse {
    batchItemFailures: Array<{ itemIdentifier: string }>;
}

/**
 * SQS FIFO → here. Answers each question and updates its placeholder in Slack.
 *
 * A record is reported as failed — and so redelivered, then dead-lettered after the queue's
 * maximum receives — when answering failed on a non-final attempt, or when the message is not a
 * valid job at all. Under FIFO, a failed record also holds back the rest of its thread, which is
 * the point: the next question in a thread should not be answered before the one it follows.
 */
export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
    const container = getSlackContainer();
    // Carry on if the credentials cannot be read: each question then fails the normal way —
    // retried, then an apology in Slack — instead of leaving the placeholder spinning.
    await loadLlmCredentials().catch((err) =>
        logger.error(`Could not load model credentials: ${(err as Error).message}`),
    );
    await reportModelMisconfiguration(container);
    const worker = container.get(SlackWorkerService);
    const { workerMaxAttempts } = container.get(SlackSettings).get();
    const batchItemFailures: SqsBatchResponse["batchItemFailures"] = [];

    for (const record of event.Records) {
        // Once one record in a FIFO batch fails, the rest must not run ahead of it.
        if (batchItemFailures.length > 0) {
            batchItemFailures.push({ itemIdentifier: record.messageId });
            continue;
        }

        const attempt = { number: Number(record.attributes?.ApproximateReceiveCount ?? "1"), max: workerMaxAttempts };
        try {
            const job = SlackJobSchema.parse(JSON.parse(record.body));
            await worker.process(job, attempt);
        } catch (err) {
            logger.error(`Message ${record.messageId} failed (attempt ${attempt.number}): ${(err as Error).message}`);
            batchItemFailures.push({ itemIdentifier: record.messageId });
            if (err instanceof RetryableJobError) await retrySoon(record.receiptHandle);
        }
    }

    return { batchItemFailures };
}

/** Best effort: if it fails, the retry still happens, just after the full visibility timeout. */
async function retrySoon(receiptHandle: string): Promise<void> {
    const queueUrl = getSlackContainer().get(SlackSettings).get().jobQueueUrl;
    if (!queueUrl) return;
    try {
        const { SQSClient, ChangeMessageVisibilityCommand } = await import("@aws-sdk/client-sqs");
        await new SQSClient({}).send(
            new ChangeMessageVisibilityCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: receiptHandle,
                VisibilityTimeout: RETRY_DELAY_SECONDS,
            }),
        );
    } catch (err) {
        logger.warn(`Could not shorten the retry delay: ${(err as Error).message}`);
    }
}
