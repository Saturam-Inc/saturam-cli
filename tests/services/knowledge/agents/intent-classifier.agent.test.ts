import { IntentClassifierAgent } from "../../../../src/services/knowledge/agents/intent-classifier.agent";
import { QuestionIntent } from "../../../../src/services/knowledge/chat-session.model";

describe("IntentClassifierAgent", () => {
    let structured: any;
    let registry: any;
    let agent: IntentClassifierAgent;

    beforeEach(() => {
        structured = { invoke: jest.fn() };
        registry = {
            describeForPrompt: jest.fn().mockResolvedValue("- SMILE [slug: smile]"),
            exampleProjectName: jest.fn().mockResolvedValue("SMILE"),
        };
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

    it("does not carry the previous project into a question about a new subject", async () => {
        // The bug this guards: the classifier inherited "saturam" from history for a question
        // about the DE Framework, which pinned retrieval to a corpus that could not answer it.
        structured.invoke.mockResolvedValue({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: [],
            crossProject: false,
            resolvedQuestion: "What are the deployment guidelines for the DE Framework?",
            reasoning: "",
        });

        const result = await agent.classify({
            question: "What are the deployment guidelines for the DE Framework?",
            recentTurns: [
                {
                    index: 0,
                    question: "what issues were found in the Saturam generator?",
                    answer: "long answer",
                    answerGist: "Saturam generator testing found several issues",
                    intent: QuestionIntent.PROJECT_KNOWLEDGE,
                    resolvedProject: "saturam",
                    retrievedChunkIds: [],
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ],
        });

        expect(result.projectHints).toEqual([]);
        // The rewritten question must not gain a project the user never named.
        expect(result.resolvedQuestion.toLowerCase()).not.toContain("saturam");

        const [{ messages }] = structured.invoke.mock.calls[0];
        expect(messages[0].content).toContain("It names its own subject");
        expect(messages[0].content).toContain("It carries no subject of its own");
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
