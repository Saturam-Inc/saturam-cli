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
- "conversation" — about this conversation itself rather than about any subject: what was asked, what was covered, a recap. Examples: "What was I asking about?", "What have we covered so far?", "Remind me what you just said". These want a short recall of the conversation, not the topic explained again.
- "small_talk" — ONLY a bare greeting, thanks, or pleasantry with no subject in it at all: "hi", "hello", "thanks", "ok", "good morning". These are NOT requests for a recap. Anything naming a subject, however briefly, is one of the other intents — never classify a real question as small talk.

Rules:
- A follow-up is not its own intent. Resolve pronouns and elisions ("it", "that", "and why?") against the conversation above, then classify the resolved question. "And how does it fail?" after a question about SMILE is "project_knowledge".
- Handle corrections. When the user is correcting or narrowing the previous question rather than asking a new one ("I meant X not Y", "no, I'm asking about X", "not that, the other one"), rebuild the PREVIOUS question with the correction applied and put that in resolvedQuestion. Carry forward the previous question's scope, including crossProject. "I'm asking about lambda functions not llama" after "do any projects use lambda?" resolves to "do any of our projects use AWS Lambda functions?" with crossProject still true — never to a question about llama.
- Prefer "project_knowledge" whenever the question names, or clearly refers to, something in the project catalogue below.
- A general concept asked in our specific context ("how do we do retries?") is "project_knowledge". The same concept asked in the abstract ("what is exponential backoff?") is "general_technical".
- Put every project name the question refers to, whether stated or inherited from the conversation, into projectHints. Use the name as the user said it; the router resolves it.
- Set crossProject to true when the question asks across projects rather than about one: "do any of our projects use Lambda?", "which project handles billing?", "where do we use Airflow?". Plural or indefinite phrasing ("our projects", "anywhere", "any of them") is the signal. When crossProject is true, leave projectHints empty unless the user named specific projects to compare.

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
  "intent": "general_technical" | "project_knowledge" | "meta" | "conversation" | "small_talk",
  "projectHints": string[],
  "crossProject": boolean,
  "resolvedQuestion": string,
  "reasoning": string
}`;
