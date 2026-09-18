import { AnswerFlowService, ProjectChooser } from "../../../src/services/knowledge/answer-flow.service";
import { QuestionIntent, createEmptySession } from "../../../src/services/knowledge/chat-session.model";
import { InMemoryConversationStore } from "../../../src/services/knowledge/conversation-store";

const smile = { slug: "smile", displayName: "SMILE", aliases: [], sources: [] };

describe("AnswerFlowService", () => {
    let classifier: any;
    let router: any;
    let general: any;
    let mentor: any;
    let followUps: any;
    let knowledgeBase: any;
    let registry: any;
    let digest: any;
    let store: InMemoryConversationStore;
    let stores: any;
    let config: any;
    let chooser: jest.Mocked<ProjectChooser>;
    let flow: AnswerFlowService;

    beforeEach(() => {
        classifier = {
            classify: jest.fn().mockResolvedValue({
                intent: QuestionIntent.PROJECT_KNOWLEDGE,
                projectHints: [],
                crossProject: false,
                resolvedQuestion: "how do refunds work?",
                reasoning: "",
            }),
        };
        router = { route: jest.fn().mockResolvedValue({ kind: "resolved", project: smile, probeChunks: [] }) };
        general = { answer: jest.fn().mockResolvedValue("general answer") };
        mentor = {
            answer: jest.fn().mockResolvedValue("mentor answer"),
            summarize: jest.fn().mockResolvedValue("gist"),
        };
        followUps = { suggest: jest.fn().mockResolvedValue([{ question: "next?", rationale: "" }]) };
        knowledgeBase = { retrieve: jest.fn().mockResolvedValue([{ content: "c", location: "s3://b/a.md" }]) };
        registry = { load: jest.fn().mockResolvedValue({ projects: [smile] }) };
        digest = { shouldRefresh: jest.fn().mockReturnValue(false), refresh: jest.fn() };
        store = new InMemoryConversationStore();
        stores = { get: jest.fn().mockResolvedValue(store) };
        config = { getOrCreateChatSessionId: jest.fn().mockResolvedValue("s1") };
        chooser = { choose: jest.fn() };

        flow = new AnswerFlowService(
            classifier,
            router,
            general,
            mentor,
            followUps,
            knowledgeBase,
            registry,
            digest,
            stores,
            config,
        );
    });

    it("answers a project question with the mentor agent, scoped to the routed project", async () => {
        const result = await flow.ask("how do refunds work?", chooser);

        expect(result.project).toEqual(smile);
        expect(result.answer).toBe("mentor answer");
        expect(knowledgeBase.retrieve).toHaveBeenCalledWith(
            "how do refunds work?",
            expect.objectContaining({ project: "smile" }),
        );
        expect(general.answer).not.toHaveBeenCalled();
    });

    it("answers a general question without retrieving anything", async () => {
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.GENERAL_TECHNICAL,
            projectHints: [],
            resolvedQuestion: "what is idempotency?",
            reasoning: "",
        });

        const result = await flow.ask("what is idempotency?", chooser);

        expect(result.answer).toBe("general answer");
        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
        expect(router.route).not.toHaveBeenCalled();
    });

    it("answers a meta question from the registry, with no model call", async () => {
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.META,
            projectHints: [],
            resolvedQuestion: "what can you tell me about?",
            reasoning: "",
        });

        const result = await flow.ask("what can you tell me about?", chooser);

        expect(result.answer).toContain("SMILE");
        expect(mentor.answer).not.toHaveBeenCalled();
        expect(general.answer).not.toHaveBeenCalled();
    });

    it("asks the user to choose when routing is ambiguous, then scopes to their pick", async () => {
        router.route.mockResolvedValueOnce({
            kind: "ambiguous",
            candidates: [{ project: smile, matchCount: 2, topScore: 0.9 }],
            probeChunks: [],
        });
        chooser.choose.mockResolvedValueOnce({ kind: "project", slug: "smile" });

        const result = await flow.ask("how do refunds work?", chooser);

        expect(chooser.choose).toHaveBeenCalled();
        expect(result.project).toEqual(smile);
    });

    it("returns cancelled without answering when the user asks to rephrase", async () => {
        router.route.mockResolvedValueOnce({
            kind: "ambiguous",
            candidates: [{ project: smile, matchCount: 2, topScore: 0.9 }],
            probeChunks: [],
        });
        chooser.choose.mockResolvedValueOnce({ kind: "rephrase" });

        const result = await flow.ask("how do refunds work?", chooser);

        expect(result.cancelled).toBe(true);
        expect(mentor.answer).not.toHaveBeenCalled();
        expect(followUps.suggest).not.toHaveBeenCalled();
    });

    it("retrieves unfiltered when the user asks across all projects", async () => {
        router.route.mockResolvedValueOnce({
            kind: "ambiguous",
            candidates: [{ project: smile, matchCount: 1, topScore: 0.5 }],
            probeChunks: [],
        });
        chooser.choose.mockResolvedValueOnce({ kind: "all" });

        await flow.ask("how do refunds work?", chooser);

        expect(knowledgeBase.retrieve).toHaveBeenCalledWith(
            "how do refunds work?",
            expect.not.objectContaining({ project: expect.anything() }),
        );
    });

    it("reuses the router's probe chunks instead of retrieving twice when no project resolved", async () => {
        const probe = [{ content: "probe", location: "s3://b/p.md" }];
        router.route.mockResolvedValueOnce({ kind: "none", probeChunks: probe });

        const result = await flow.ask("how do refunds work?", chooser);

        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
        expect(result.chunks).toEqual(probe);
    });

    it("searches for the resolved question so pronouns reach retrieval", async () => {
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: [],
            resolvedQuestion: "how does SMILE refund processing fail?",
            reasoning: "",
        });

        await flow.ask("and how does it fail?", chooser);

        expect(knowledgeBase.retrieve).toHaveBeenCalledWith(
            "how does SMILE refund processing fail?",
            expect.anything(),
        );
    });

    it("recalls the conversation instead of re-explaining the topic", async () => {
        // The bug this guards: "what was I asking about?" used to run the full pipeline and
        // re-explain the subject at length instead of simply recalling it.
        await store.appendTurn("s1", {
            index: 0,
            question: "how does the ARAP data mart work?",
            answer: "long answer",
            answerGist: "ARAP uses double-entry for receivables and payables",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "smile",
            retrievedChunkIds: [],
            createdAt: new Date().toISOString(),
        });
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.CONVERSATION,
            projectHints: [],
            crossProject: false,
            resolvedQuestion: "what was I asking about?",
            reasoning: "",
        });

        const result = await flow.ask("what was I asking about?", chooser);

        expect(result.answer).toContain("how does the ARAP data mart work?");
        expect(result.answer).toContain("double-entry");
        expect(mentor.answer).not.toHaveBeenCalled();
        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
    });

    it("says so plainly when asked to recap an empty conversation", async () => {
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.CONVERSATION,
            projectHints: [],
            crossProject: false,
            resolvedQuestion: "what have we covered?",
            reasoning: "",
        });

        const result = await flow.ask("what have we covered?", chooser);

        expect(result.answer).toContain("first question");
    });

    it("searches every project when the question spans projects", async () => {
        // "do any of our projects use Lambda?" must not inherit the sticky project, or the answer
        // reports on one project while sounding like it covered them all.
        await store.saveActiveProject("s1", "smile");
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: [],
            crossProject: true,
            resolvedQuestion: "do any of our projects use Lambda?",
            reasoning: "",
        });

        const result = await flow.ask("do any of our projects use Lambda?", chooser);

        expect(router.route).not.toHaveBeenCalled();
        expect(result.project).toBeUndefined();
        expect(knowledgeBase.retrieve).toHaveBeenCalledWith(
            "do any of our projects use Lambda?",
            expect.not.objectContaining({ project: expect.anything() }),
        );
    });

    it("persists the turn with its gist and makes the project sticky", async () => {
        await flow.ask("how do refunds work?", chooser);

        const session = await store.load("s1");
        expect(session.turns).toHaveLength(1);
        expect(session.turns[0]).toMatchObject({
            question: "how do refunds work?",
            answerGist: "gist",
            resolvedProject: "smile",
        });
        expect(session.activeProject).toBe("smile");
    });

    it("refreshes the digest only when the digest service says it is due", async () => {
        digest.shouldRefresh.mockReturnValue(true);
        digest.refresh.mockResolvedValue({
            summary: "s",
            projectsDiscussed: [],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 1,
        });

        await flow.ask("how do refunds work?", chooser);

        const session = await store.load("s1");
        expect(session.digest?.summary).toBe("s");
    });

    it("still answers when retrieval fails, falling back to the probe chunks", async () => {
        knowledgeBase.retrieve.mockRejectedValueOnce(new Error("bedrock down"));

        const result = await flow.ask("how do refunds work?", chooser);

        expect(result.answer).toBe("mentor answer");
        expect(result.chunks).toEqual([]);
    });
});
