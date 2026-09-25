import { getFollowUpMessages } from "../../src/prompts/follow-up.prompt";
import { getKnowledgeBaseChatMessages } from "../../src/prompts/knowledge-base-chat.prompt";
import { getMentorAgentMessages } from "../../src/prompts/mentor-agent.prompt";
import { getReviseAnswerMessages } from "../../src/prompts/revise-answer.prompt";
import { getSessionDigestMessages } from "../../src/prompts/session-digest.prompt";
import { KNOWLEDGE_TOOL_DEFINITIONS } from "../../src/services/knowledge/agent/knowledge-tools";

/**
 * Guards the rule that prompts carry no client's vocabulary.
 *
 * Every project name a prompt uses must come in through its parameters — from the registry, or
 * from the retrieved documents' metadata — never from the prompt text itself. The CLI is one
 * binary serving every client's deployment, so a name baked in here ships to all of them.
 *
 * The prompts are rendered here with deliberately neutral inputs, so anything on the list below
 * that still appears can only have come from the prompt source. Extend the list whenever a new
 * client's terms are noticed in a prompt; the test is the reason they will not be there for long.
 *
 * This used to render twelve prompts. It renders four, plus the tool descriptions — which are now
 * prompt text too, and are the one place a new capability gets described to the model. What the
 * mentor prompt actually instructs is asserted in mentor-agent.prompt.test.ts; this file only
 * guards vocabulary.
 */
const CLIENT_TERMS = [
    /\bMRF\b/,
    /\bSMILE\b/,
    /\bARAP\b/,
    /\bADF\b/,
    /\bAirflow\b/,
    /\bQualdo\b/,
    /DE Framework/,
    /\bpkl\b/,
    /spend domain/i,
    /Azure Data Factory/,
    /cons\.sh/,
];

const NEUTRAL = {
    question: "how does the scheduler decide what to run?",
    answer: "It reads a table of jobs and runs whichever are due.",
};

/** Every prompt the chat flow can send, rendered with inputs that name no project. */
function renderAll(): Array<{ name: string; text: string }> {
    const flat = (name: string, messages: Array<{ content: unknown }>) => ({
        name,
        text: messages.map((m) => String(m.content)).join("\n"),
    });
    const kb = getKnowledgeBaseChatMessages({ question: NEUTRAL.question, chunks: [] });

    return [
        flat("mentor-agent (tool-calling)", getMentorAgentMessages({ question: NEUTRAL.question, recentTurns: [] })),
        flat(
            "mentor-agent (no tool calling)",
            getMentorAgentMessages({
                question: NEUTRAL.question,
                recentTurns: [],
                preGatheredContext: "(nothing retrieved)",
            }),
        ),
        flat("follow-up", getFollowUpMessages({ question: NEUTRAL.question, answer: NEUTRAL.answer, chunks: [] })),
        flat(
            "revise-answer",
            getReviseAnswerMessages({
                question: NEUTRAL.question,
                answer: NEUTRAL.answer,
                unsupported: ["run_jobs.sh"],
            }),
        ),
        flat("session-digest", getSessionDigestMessages({ turns: [] })),
        flat("knowledge-base-chat", [kb.system, kb.user]),
        {
            name: "tool definitions",
            text: KNOWLEDGE_TOOL_DEFINITIONS.map((tool) => `${tool.name}\n${tool.description}`).join("\n"),
        },
    ];
}

describe("prompts carry no client vocabulary", () => {
    it.each(renderAll())("$name", ({ text }) => {
        const found = CLIENT_TERMS.filter((term) => term.test(text)).map(String);
        expect(found).toEqual([]);
    });
});
