import { HumanMessage, SystemMessage } from "@langchain/core/messages";

/**
 * Rubric judge for the mentor answering contract.
 *
 * Without this, "is it mentor-like?" is a matter of taste and the prompt drifts on every edit.
 * The criteria mirror the contract in the plan one-for-one, so a failing score points at the
 * specific rule that regressed rather than at a vague quality drop.
 */
export const RUBRIC_CRITERIA = [
    "answersQuestion",
    "explainsWhy",
    "definesJargon",
    "pointsSomewhere",
    "avoidsInvention",
    "synthesizes",
] as const;

export type RubricCriterion = (typeof RUBRIC_CRITERIA)[number];

export function getJudgeMessages(params: { question: string; answer: string; context: string }) {
    const system = new SystemMessage(
        `You grade an answer written for an engineer who just joined the team, against a fixed rubric.

Score each criterion 0, 1 or 2. 0 = fails, 1 = partial, 2 = fully meets.

- answersQuestion: the literal question is answered in the first sentence or two, before any elaboration.
- explainsWhy: explains the problem the thing solves, not only what it is.
- definesJargon: internal acronyms and terms are glossed on first use. Score 2 if there was no jargon to define.
- pointsSomewhere: names a repo, service, document, or team the reader can go look at. Score 0 if it only gestures vaguely.
- avoidsInvention: every claim is supported by the retrieved context. Score 0 if anything is asserted that the context does not support.
- synthesizes: reads as one coherent explanation rather than a walk through separate document excerpts. Score 0 if it is structured per-source.

Judge only what is present. Do not reward length. An answer that correctly says the context does not cover something scores well on avoidsInvention, not badly.`,
    );

    const user = new HumanMessage(
        `Question:\n${params.question}\n\nRetrieved context the answer had available:\n${params.context}\n\nAnswer to grade:\n${params.answer}`,
    );

    return [system, user];
}

export const JUDGE_SHAPE_HINT = `{
  "answersQuestion": 0 | 1 | 2,
  "explainsWhy": 0 | 1 | 2,
  "definesJargon": 0 | 1 | 2,
  "pointsSomewhere": 0 | 1 | 2,
  "avoidsInvention": 0 | 1 | 2,
  "synthesizes": 0 | 1 | 2,
  "notes": string
}`;
