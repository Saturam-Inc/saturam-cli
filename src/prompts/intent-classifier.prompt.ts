import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatTurn, SessionDigest } from "../services/knowledge/chat-session.model";

/**
 * Builds the intent-classification prompt.
 *
 * Message layout matters here. Instructions go in the system message and stay identical every
 * turn, so the prefix remains cacheable; conversation history goes in the message array as
 * attributed Human/AI pairs rather than being flattened into the system prompt, which would
 * change the cacheable prefix on every turn and lose role attribution. Older history arrives as
 * a compact digest rather than raw pairs — classification depends on recency, and twenty full
 * mentor-length answers would make the cheapest decision in the flow the most expensive call.
 */
export function getIntentClassifierMessages(params: {
    question: string;
    recentTurns: ChatTurn[];
    digest?: SessionDigest;
    projectCatalogue: string;
}): BaseMessage[] {
    const system = new SystemMessage(
        `You classify an engineer's question so it can be routed to the right answering agent.

Choose exactly one intent:
- "general_technical" — answerable from general software engineering knowledge, with no reference to our internal systems. Example: "What is idempotency?"
- "project_knowledge" — about one of our internal projects, services, tickets or documents. Example: "How does SMILE handle refunds?"
- "meta" — about what this assistant or the knowledge base can do, rather than about any subject. Example: "What projects can you tell me about?"

Rules:
- A follow-up is not its own intent. Resolve pronouns and elisions ("it", "that", "and why?") against the conversation above, then classify the resolved question. "And how does it fail?" after a question about SMILE is "project_knowledge".
- Prefer "project_knowledge" whenever the question names, or clearly refers to, something in the project catalogue below.
- A general concept asked in our specific context ("how do we do retries?") is "project_knowledge". The same concept asked in the abstract ("what is exponential backoff?") is "general_technical".
- Put every project name the question refers to, whether stated or inherited from the conversation, into projectHints. Use the name as the user said it; the router resolves it.

Projects currently indexed:
${params.projectCatalogue}`,
    );

    // Recent turns as attributed messages. Answers are sent as one-line gists: the classifier
    // needs the subject of the previous turn, not its full explanation.
    const history: BaseMessage[] = params.recentTurns.flatMap((turn) => [
        new HumanMessage(turn.question),
        new AIMessage(turn.answerGist),
    ]);

    const digestBlock = params.digest
        ? `Earlier in this conversation: ${params.digest.summary}\nProjects discussed: ${params.digest.projectsDiscussed.join(", ") || "none"}\n\n`
        : "";

    return [system, ...history, new HumanMessage(`${digestBlock}Question to classify: ${params.question}`)];
}

export const INTENT_CLASSIFIER_SHAPE_HINT = `{
  "intent": "general_technical" | "project_knowledge" | "meta",
  "projectHints": string[],
  "resolvedQuestion": string,
  "reasoning": string
}`;
