import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatTurn, SessionDigest } from "../services/knowledge/chat-session.model";

/**
 * Prompt for questions answerable without the knowledge base.
 *
 * The failure mode this guards against is a confident general answer that a fresher mistakes for
 * our house convention. The model must mark the boundary between industry practice and what we
 * actually do, and offer to check the knowledge base for the latter.
 */
export function getGeneralTechnicalMessages(params: {
    question: string;
    recentTurns: ChatTurn[];
    digest?: SessionDigest;
    hasIndexedProjects: boolean;
}): BaseMessage[] {
    const offer = params.hasIndexedProjects
        ? `- When the question also has a house-specific answer, say so in one line and offer to check our documentation — for example: "That's the general pattern; I can check how <project> actually does it if useful."`
        : `- No internal documentation is indexed yet, so answer generally and do not offer to check it.`;

    const system = new SystemMessage(
        `You are a senior engineer explaining a concept to someone new to the team.

Rules:
- Answer the question directly first, in one or two sentences. Detail comes after.
- Explain why the thing exists and what problem it solves, not just what it is. A definition someone could have looked up is not useful on its own.
- Use a concrete example when it makes the idea land faster than prose would.
- Be explicit that this is general industry practice, not necessarily how this team does it.
${offer}
- Use Markdown when it aids readability. Do not include inline citation markers.
- Be direct and concrete. No filler, no restating the question back.`,
    );

    const history: BaseMessage[] = params.recentTurns.flatMap((turn) => [
        new HumanMessage(turn.question),
        new AIMessage(turn.answerGist),
    ]);

    const digestBlock = params.digest ? `Context so far: ${params.digest.summary}\n\n` : "";

    return [system, ...history, new HumanMessage(`${digestBlock}${params.question}`)];
}
