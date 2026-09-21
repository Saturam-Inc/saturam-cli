import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatTurn, SessionDigest } from "../services/knowledge/chat-session.model";

/**
 * Prompts for the comprehension check — the thing that separates a trainer from a good FAQ.
 *
 * Both work from the session's own recent answers rather than from retrieval. The point of a
 * check is to find out what stuck from what was actually explained, so the material is exactly
 * what the learner was told, not what the corpus could have told them.
 */

/** Characters of each recent answer the quiz-writer sees. Whole answers, minus the very long tail. */
const ANSWER_CHARS = 2500;

export function getQuizPoseMessages(params: { recentTurns: ChatTurn[]; digest?: SessionDigest }): BaseMessage[] {
    const system = new SystemMessage(
        `You are a mentor checking whether a new engineer has absorbed what you just explained to them.

Write ONE question, answerable from the explanations below, about the point that matters most in them — a mechanism, a dependency, or a gotcha. Never trivia: not a port number, not a file name for its own sake, not a date. A good question is one where a right answer shows they understood *why*, and a wrong one shows exactly what to re-read.

Rules:
- One question, one or two sentences, answerable in a sentence or two. Concrete, not "explain X".
- Ask about the most recent explanations first; older ones only if the recent ones have nothing worth checking.
- Give the model answer in two or three sentences, and the 2 to 4 key points a good answer would hit.
- Write the question the way you would say it to them: "Quick check — …".`,
    );

    const material = params.recentTurns
        .map(
            (turn, index) =>
                `Explanation ${index + 1}\nThey asked: ${turn.question}\nYou told them:\n${turn.answer.slice(0, ANSWER_CHARS)}`,
        )
        .join("\n\n---\n\n");

    const digestBlock = params.digest?.summary ? `Earlier in the conversation: ${params.digest.summary}\n\n` : "";

    return [system, new HumanMessage(`${digestBlock}Recent explanations:\n${material}`)];
}

export const QUIZ_POSE_SHAPE_HINT = `{
  "question": string,
  "modelAnswer": string,
  "keyPoints": string[]
}`;

export function getQuizAssessMessages(params: {
    question: string;
    modelAnswer: string;
    keyPoints: string[];
    learnerAnswer: string;
}): BaseMessage[] {
    const system = new SystemMessage(
        `You are a mentor responding to a new engineer's answer to your check question.

- Start with what they got right, specifically — name the point, do not just say "good".
- Then what they missed or got wrong, plainly and kindly, and give the correct version in a sentence or two.
- If they said they do not know, or guessed wildly, explain the answer as you would have the first time, briefly, and say what to re-read.
- End with the one line worth remembering.
- Under 150 words. Plain, warm, direct. No scores, no grades, no "Great job!", no checklists of criteria.
- Never introduce new facts beyond the model answer and key points.`,
    );

    return [
        system,
        new HumanMessage(
            `Your question: ${params.question}\n\nModel answer: ${params.modelAnswer}\nKey points: ${params.keyPoints.join("; ")}\n\nTheir answer: ${params.learnerAnswer}`,
        ),
    ];
}
