import { IntentClassifierAgent } from "../../../../src/services/knowledge/agents/intent-classifier.agent";
import { QuestionIntent } from "../../../../src/services/knowledge/chat-session.model";

describe("IntentClassifierAgent", () => {
    let structured: any;
    let registry: any;
    let agent: IntentClassifierAgent;

    beforeEach(() => {
        structured = { invoke: jest.fn() };
        registry = { describeForPrompt: jest.fn().mockResolvedValue("- SMILE [slug: smile]") };
        agent = new IntentClassifierAgent(structured, registry);
    });

    it("passes the project catalogue and returns the classification", async () => {
        structured.invoke.mockResolvedValue({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: ["SMILE"],
            resolvedQuestion: "how does SMILE refund?",
            reasoning: "names a project",
        });

        const result = await agent.classify({ question: "how does SMILE refund?", recentTurns: [] });

        expect(result.intent).toBe(QuestionIntent.PROJECT_KNOWLEDGE);
        const [{ messages }] = structured.invoke.mock.calls[0];
        expect(messages[0].content).toContain("SMILE [slug: smile]");
    });

    it("sends history as attributed messages rather than folding it into the system prompt", async () => {
        structured.invoke.mockResolvedValue({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: [],
            resolvedQuestion: "how does it fail?",
            reasoning: "",
        });

        await agent.classify({
            question: "and how does it fail?",
            recentTurns: [
                {
                    index: 0,
                    question: "what is the sync?",
                    answer: "long answer",
                    answerGist: "the sync copies documents",
                    intent: QuestionIntent.PROJECT_KNOWLEDGE,
                    retrievedChunkIds: [],
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ],
        });

        const [{ messages }] = structured.invoke.mock.calls[0];
        // system, human, ai, human — history is in the message array, keeping the system prompt
        // stable across turns and preserving who said what.
        expect(messages).toHaveLength(4);
        expect(messages[0]._getType()).toBe("system");
        expect(messages[1]._getType()).toBe("human");
        expect(messages[2]._getType()).toBe("ai");
        expect(messages[2].content).toBe("the sync copies documents");
        expect(messages[0].content).not.toContain("the sync copies documents");
    });

    it("replays the gist, not the full answer, so long histories stay affordable", async () => {
        structured.invoke.mockResolvedValue({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: [],
            resolvedQuestion: "q",
            reasoning: "",
        });

        await agent.classify({
            question: "q",
            recentTurns: [
                {
                    index: 0,
                    question: "what is the sync?",
                    answer: "x".repeat(3000),
                    answerGist: "short gist",
                    intent: QuestionIntent.PROJECT_KNOWLEDGE,
                    retrievedChunkIds: [],
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ],
        });

        const [{ messages }] = structured.invoke.mock.calls[0];
        const joined = messages.map((m: any) => m.content).join("");
        expect(joined).toContain("short gist");
        expect(joined).not.toContain("x".repeat(3000));
    });

    it("defaults to project knowledge when classification fails", async () => {
        structured.invoke.mockRejectedValue(new Error("provider down"));

        const result = await agent.classify({ question: "anything", recentTurns: [] });

        // Retrieval-backed answering can still handle a general question; the general path would
        // skip our documentation entirely, so it is the more damaging default.
        expect(result.intent).toBe(QuestionIntent.PROJECT_KNOWLEDGE);
        expect(result.resolvedQuestion).toBe("anything");
    });
});
