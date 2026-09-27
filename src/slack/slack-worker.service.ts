import { getLogger } from "log4js";
import { Service } from "typedi";
import { AnswerFlowService } from "../services/knowledge/answer-flow.service";
import { SlackGateway } from "./slack-gateway";
import { SlackStateService } from "./slack-state.service";
import { slackSessionRef } from "./slack-identity";
import { FeedbackJob, QuestionJob, SlackJob } from "./slack-jobs";
import {
    AskedQuestion,
    FEEDBACK_THANKS,
    SlackMessage,
    answerMessage,
    failureMessage,
    retryingMessage,
} from "./slack-messages";

const logger = getLogger("SlackWorker");

export interface Attempt {
    /** 1-based: SQS's ApproximateReceiveCount. */
    number: number;
    /** The queue's maximum receives — the attempt after which the message goes to the DLQ. */
    max: number;
}

/** Thrown to make the queue deliver the job again. */
export class RetryableJobError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "RetryableJobError";
    }
}

/**
 * Does the slow part: answers the question with the same AnswerFlowService the terminal uses, in
 * the conversation the thread belongs to, and replaces the "Thinking…" placeholder with the result.
 *
 * Retrying is safe because of where AnswerFlowService fails: every step that can throw — the agent,
 * retrieval, the model — runs before the turn is recorded, so a failed attempt leaves no trace
 * in the conversation and the next one starts clean.
 */
@Service()
export class SlackWorkerService {
    constructor(
        private readonly answerFlow: AnswerFlowService,
        private readonly gateway: SlackGateway,
        private readonly state: SlackStateService,
    ) {}

    public async process(job: SlackJob, attempt: Attempt = { number: 1, max: 1 }): Promise<void> {
        if (job.kind === "feedback") return this.recordFeedback(job);
        return this.answer(job, attempt);
    }

    private async answer(job: QuestionJob, attempt: Attempt): Promise<void> {
        const conversation = slackSessionRef(job);
        const asked: AskedQuestion = { question: job.question, source: job.source, userId: job.userId };
        const started = Date.now();

        let message: SlackMessage;
        try {
            const result = await this.answerFlow.ask(job.question, conversation);
            message = answerMessage(result, asked, conversation);
            logger.info(
                `Answered ${job.id} in ${Date.now() - started}ms (attempt ${attempt.number}/${attempt.max}, ` +
                    `${result.chunks.length} chunk(s), project ${result.project?.slug ?? "none"}).`,
            );
        } catch (err) {
            const final = attempt.number >= attempt.max;
            logger.error(
                `Answering ${job.id} failed on attempt ${attempt.number}/${attempt.max}` +
                    `${final ? " — giving up" : " — will retry"}: ${(err as Error).stack ?? err}`,
            );
            if (!final) {
                await this.gateway
                    .update(job.channelId, job.placeholderTs, retryingMessage(asked))
                    .catch((updateErr) =>
                        logger.warn(`Could not show the retry notice: ${(updateErr as Error).message}`),
                    );
                throw new RetryableJobError(`Answering ${job.id} failed; retrying.`, { cause: err });
            }
            message = failureMessage(asked, job.id);
        }

        try {
            await this.gateway.update(job.channelId, job.placeholderTs, message);
        } catch (err) {
            // Never retried: the turn is already recorded, so another attempt would answer — and
            // record — the same question twice. Post a fresh reply instead, then give up.
            logger.error(`Could not replace the placeholder for ${job.id}: ${(err as Error).message}`);
            await this.gateway
                .postInThread(job.channelId, job.threadTs, message)
                .catch((postErr) =>
                    logger.error(`Could not post the answer for ${job.id}: ${(postErr as Error).message}`),
                );
        }
    }

    private async recordFeedback(job: FeedbackJob): Promise<void> {
        await this.state.recordFeedback(job);
        logger.info(`Recorded ${job.rating} feedback on ${job.channelId}/${job.messageTs}.`);
        await this.gateway
            .whisper(job.channelId, job.userId, FEEDBACK_THANKS, job.threadTs)
            .catch((err) => logger.warn(`Could not thank ${job.userId}: ${(err as Error).message}`));
    }
}
