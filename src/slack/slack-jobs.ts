import { z } from "zod";

/**
 * Work handed from the ingress to the worker — the only contract between the two Lambdas, and
 * the body of every SQS message. Validated on both sides of the queue: a message that fails here
 * is a deploy mismatch or a hand-edited message, and belongs in the dead-letter queue, not in the
 * answering flow.
 */

/** Long enough for any real question, short enough that one message cannot run up the bill. */
export const MAX_QUESTION_CHARS = 4000;

const SlackIds = {
    /** Unique per job, and the SQS FIFO deduplication id — so a job enqueued twice runs once. */
    id: z.string().min(1).max(128),
    teamId: z.string().min(1),
    channelId: z.string().min(1),
    userId: z.string().min(1),
    /** Root of the thread the answer belongs in; also what the session id is derived from. */
    threadTs: z.string().regex(/^\d+\.\d+$/),
};

export const QuestionJobSchema = z.object({
    kind: z.literal("question"),
    ...SlackIds,
    question: z.string().min(1).max(MAX_QUESTION_CHARS),
    /** How it was asked. A clicked follow-up is echoed in the answer, since nobody typed it. */
    source: z.enum(["mention", "direct_message", "follow_up"]),
    /** The "Thinking…" message the ingress posted, which the worker replaces with the answer. */
    placeholderTs: z.string().min(1),
});

export const FeedbackJobSchema = z.object({
    kind: z.literal("feedback"),
    ...SlackIds,
    /** The answer message being rated. */
    messageTs: z.string().min(1),
    /** The conversation the rated answer belongs to, as recorded on its buttons. */
    ownerId: z.string().min(1),
    sessionId: z.string().min(1),
    rating: z.enum(["up", "down"]),
});

export const SlackJobSchema = z.discriminatedUnion("kind", [QuestionJobSchema, FeedbackJobSchema]);

export type QuestionJob = z.infer<typeof QuestionJobSchema>;
export type FeedbackJob = z.infer<typeof FeedbackJobSchema>;
export type SlackJob = z.infer<typeof SlackJobSchema>;

/**
 * Jobs in one thread run one at a time, in order (the SQS FIFO message group). Two quick
 * messages in a thread would otherwise be answered concurrently, each blind to the other.
 * Different threads still run in parallel.
 */
export function jobGroupKey(job: Pick<SlackJob, "channelId" | "threadTs">): string {
    return `${job.channelId}:${job.threadTs}`;
}
