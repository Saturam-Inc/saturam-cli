import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatTurn, SessionDigest } from "../services/knowledge/chat-session.model";

/**
 * Rebuilds the rolling conversation digest.
 *
 * This is what makes a long history affordable: the full turns stay in DynamoDB, while agents
 * receive this summary plus a few verbatim turns. Regenerated every few turns rather than every
 * turn, so it costs roughly one extra call per five questions.
 */
export function getSessionDigestMessages(params: { turns: ChatTurn[]; previousDigest?: SessionDigest }): BaseMessage[] {
    const system = new SystemMessage(
        `You maintain a running summary of a technical conversation, so later turns can be understood without replaying every message.

Produce:
- summary: what the conversation has covered, under 120 words. Written so someone reading only this can resolve a pronoun in the next question.
- projectsDiscussed: internal project names mentioned, most recent first.
- jargonDefined: internal terms and acronyms that have already been explained, so they are not explained twice.
- questionsAsked: the questions asked so far, condensed to their subject.

Merge the previous summary with the new turns rather than starting over. Keep it factual; omit anything not actually discussed.`,
    );

    const previous = params.previousDigest
        ? `Previous summary:\n${params.previousDigest.summary}\nProjects: ${params.previousDigest.projectsDiscussed.join(", ")}\nJargon defined: ${params.previousDigest.jargonDefined.join(", ")}\nQuestions asked: ${params.previousDigest.questionsAsked.join("; ")}\n\n`
        : "";

    const transcript = params.turns
        .map(
            (turn) =>
                `Q: ${turn.question}\nA: ${turn.answerGist}${turn.resolvedProject ? ` [project: ${turn.resolvedProject}]` : ""}`,
        )
        .join("\n\n");

    return [system, new HumanMessage(`${previous}New turns:\n${transcript}`)];
}

export const SESSION_DIGEST_SHAPE_HINT = `{
  "summary": string,
  "projectsDiscussed": string[],
  "jargonDefined": string[],
  "questionsAsked": string[]
}`;
