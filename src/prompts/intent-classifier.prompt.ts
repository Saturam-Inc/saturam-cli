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
    /** A project that exists in this deployment, for the examples below. See ProjectRegistryService.exampleProjectName. */
    exampleProject: string;
}): BaseMessage[] {
    const ex = params.exampleProject;
    const system = new SystemMessage(
        `You classify an engineer's question so it can be routed to the right answering agent.

Choose exactly one intent:
- "general_technical" — answerable from general software engineering knowledge, with no reference to our internal systems. Example: "What is idempotency?"
- "project_knowledge" — about one of our internal projects, services, tickets or documents, as they are today. Example: "How does ${ex} handle refunds?"
- "change_impact" — about changing one of our systems, or about what would happen if it changed. The user wants to act, not just understand. Examples: "What should I change to move the nightly job to Friday?", "What happens if I change the output path?", "If I add a new data source, what do I need to update?", "Is it safe to turn off that task?", "How do I enable X?". Signals: "what should I change", "how do I add/enable/disable/move", "what happens if", "what breaks", "is it safe to", "what needs updating". A question that merely asks how something currently works is NOT this — "how does the scheduler work?" is project_knowledge, "how do I change the scheduler?" is change_impact.
- "meta" — about what this assistant or the knowledge base can do, rather than about any subject. Example: "What projects can you tell me about?"
- "conversation" — about this conversation itself rather than about any subject: what was asked, what was covered, a recap. Examples: "What was I asking about?", "What have we covered so far?", "Remind me what you just said". These want a short recall of the conversation, not the topic explained again.
- "small_talk" — ONLY a bare greeting, thanks, or pleasantry with no subject in it at all: "hi", "hello", "thanks", "ok", "good morning". These are NOT requests for a recap. Anything naming a subject, however briefly, is one of the other intents — never classify a real question as small talk.

Rules:
- A follow-up is not its own intent. Resolve pronouns and elisions ("it", "that", "and why?") against the conversation above, then classify the resolved question. "And how does it fail?" after a question about ${ex} is "project_knowledge".
- Handle corrections. When the user is correcting or narrowing the previous question rather than asking a new one ("I meant X not Y", "no, I'm asking about X", "not that, the other one"), rebuild the PREVIOUS question with the correction applied and put that in resolvedQuestion. Carry forward the previous question's scope, including crossProject. "I'm asking about lambda functions not llama" after "do any projects use lambda?" resolves to "do any of our projects use AWS Lambda functions?" with crossProject still true — never to a question about llama.
- Prefer "project_knowledge" whenever the question names, or clearly refers to, something in the project catalogue below.
- Between "project_knowledge" and "change_impact", the test is whether the user is about to do something. Wanting to know how a thing works is project_knowledge; wanting to know what to edit, or what an edit would cause, is change_impact — even when the two are asked in the same breath. A follow-up can change this: after "how does the scheduler work?", the question "and how would I change it to Friday?" is change_impact.
- A general concept asked in our specific context ("how do we do retries?") is "project_knowledge". The same concept asked in the abstract ("what is exponential backoff?") is "general_technical".
- Decide first whether the question carries a subject of its own.
  - **It names its own subject** — "What are the guidelines for writing migration scripts?" — then projectHints gets a project only if that subject is itself a project name. A new subject that is not a project name gets EMPTY hints, even if another project was discussed a moment ago. Carrying the earlier project forward here is the most damaging mistake you can make: it pins the search to a corpus that cannot answer the question.
  - **It carries no subject of its own** — a pronoun, an ellipsis, or a bare continuation such as "and how does it fail?", "so what tech stacks are used", "tell me more", "what about the timings?" — then it continues the previous turn. Put the previous turn's project in projectHints, and rewrite resolvedQuestion into a standalone question naming that subject: after a question about ${ex}, "so what tech stacks are used" becomes "what tech stacks are used in ${ex}".
- resolvedQuestion must stand on its own, but never invent scope. Resolve pronouns and ellipsis into the subject actually being discussed; do not widen a question to "our projects" or "all projects" unless the user genuinely asked across projects, and do not attach a project the user neither named nor was discussing.
- Set crossProject to true when the question asks across projects rather than about one: "do any of our projects use Lambda?", "which project handles billing?", "where do we use Terraform?". Plural or indefinite phrasing ("our projects", "anywhere", "any of them") is the signal. When crossProject is true, leave projectHints empty unless the user named specific projects to compare.

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
  "intent": "general_technical" | "project_knowledge" | "change_impact" | "meta" | "conversation" | "small_talk",
  "projectHints": string[],
  "crossProject": boolean,
  "resolvedQuestion": string,
  "reasoning": string
}`;
