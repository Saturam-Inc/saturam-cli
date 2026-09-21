import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { QUIZ_POSE_SHAPE_HINT, getQuizAssessMessages, getQuizPoseMessages } from "../../../prompts/quiz.prompt";
import { LlmService } from "../../llm-service";
import { ChatTurn, SessionDigest } from "../chat-session.model";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("Quiz");

/** Posing is a judgement about what mattered; deterministic. Feedback is prose; a little give. */
const POSE_TEMPERATURE = 0;
const ASSESS_TEMPERATURE = 0.3;

/** Recent turns the quiz draws on. Enough for a real check; recent enough that it is fair. */
const QUIZ_SOURCE_TURNS = 4;

export const QuizQuestionSchema = z.object({
    question: z.string(),
    modelAnswer: z.string().default(""),
    keyPoints: z.array(z.string()).default([]),
});

export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

/**
 * Runs the comprehension check: poses one question from what was recently explained, then gives
 * feedback on the learner's answer.
 *
 * Its own agent rather than a mode of the writer, because it is a genuinely different job: it
 * reads the conversation's own answers, never the corpus, and it produces a question and then a
 * judgement rather than an explanation.
 */
@Service()
export class QuizAgent {
    constructor(
        private readonly structured: StructuredOutputService,
        private readonly llm: LlmService,
    ) {}

    /** Writes one check question from the last few explanations. Throws when there is nothing to ask about. */
    public async pose(params: { turns: ChatTurn[]; digest?: SessionDigest }): Promise<QuizQuestion> {
        const recentTurns = params.turns.slice(-QUIZ_SOURCE_TURNS).filter((turn) => turn.answer.trim().length > 0);
        if (recentTurns.length === 0) {
            throw new Error("Nothing has been explained yet, so there is nothing to check.");
        }

        const result = await this.structured.invoke({
            schema: QuizQuestionSchema,
            name: "pose_check_question",
            shapeHint: QUIZ_POSE_SHAPE_HINT,
            messages: getQuizPoseMessages({ recentTurns, digest: params.digest }),
            options: { temperature: POSE_TEMPERATURE },
        });

        if (!result.question.trim()) {
            throw new Error("Could not put a check question together from the recent explanations.");
        }
        logger.debug(`Posed check question: ${result.question}`);
        return result;
    }

    /** Feedback on the learner's answer. Never throws: a check must not end the conversation. */
    public async assess(params: { quiz: QuizQuestion; learnerAnswer: string }): Promise<string> {
        try {
            const feedback = await this.llm.prompt(
                getQuizAssessMessages({
                    question: params.quiz.question,
                    modelAnswer: params.quiz.modelAnswer,
                    keyPoints: params.quiz.keyPoints,
                    learnerAnswer: params.learnerAnswer,
                }),
                undefined,
                { temperature: ASSESS_TEMPERATURE },
            );
            return feedback.trim();
        } catch (err) {
            logger.debug(`Quiz assessment failed (${(err as Error).message}) — giving the model answer instead.`);
            const points = params.quiz.keyPoints.length
                ? `\n\nThe points to hold onto: ${params.quiz.keyPoints.join("; ")}.`
                : "";
            return `I could not grade that just now, so here is the answer I was looking for: ${params.quiz.modelAnswer}${points}`;
        }
    }
}
