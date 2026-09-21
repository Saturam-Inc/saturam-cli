import {
    AnswerCoverage,
    AnswerFlowService,
    ORIENTATION_OPTIONS,
    ProjectChooser,
} from "../../../src/services/knowledge/answer-flow.service";
import {
    LearnerStage,
    QUIZ_MENU_TEXT,
    QuestionIntent,
    createEmptySession,
} from "../../../src/services/knowledge/chat-session.model";
import { InMemoryConversationStore } from "../../../src/services/knowledge/conversation-store";
import { getOwnerId } from "../../../src/services/knowledge/session-identity";

const smile = { slug: "smile", displayName: "SMILE", aliases: [], sources: [] };
const ref = (sessionId: string) => ({ ownerId: getOwnerId(), sessionId });

describe("AnswerFlowService", () => {
    let classifier: any;
    let router: any;
    let planner: any;
    let writer: any;
    let verify: any;
    let followUps: any;
    let quiz: any;
    let knowledgeBase: any;
    let registry: any;
    let digest: any;
    let store: InMemoryConversationStore;
    let stores: any;
    let config: any;
    let chooser: jest.Mocked<ProjectChooser>;
    let loadCurrent: () => Promise<any>;
    let flow: AnswerFlowService;

    beforeEach(() => {
        classifier = {
            classify: jest.fn().mockResolvedValue({
                intent: QuestionIntent.PROJECT_KNOWLEDGE,
                projectHints: [],
                crossProject: false,
                // A stated goal, so the default first ask is answered rather than met with the
                // orientation question. Orientation has its own tests below.
                statedGoal: "understanding how it works",
                resolvedQuestion: "how do refunds work?",
                reasoning: "",
            }),
        };
        router = { route: jest.fn().mockResolvedValue({ kind: "resolved", project: smile, probeChunks: [] }) };
        planner = {
            plan: jest.fn().mockResolvedValue({ intent: "", queries: ["where configured", "what triggers it"] }),
        };
        writer = {
            describe: jest.fn().mockResolvedValue("mentor answer"),
            advise: jest.fn().mockResolvedValue("change plan"),
            general: jest.fn().mockResolvedValue("general answer"),
            summarize: jest.fn().mockResolvedValue("gist"),
            revise: jest.fn().mockResolvedValue("revised answer"),
        };
        verify = {
            screen: jest.fn().mockResolvedValue({ verdict: "sufficient", missing: "", alternativeQuestions: [] }),
        };
        followUps = { suggest: jest.fn().mockResolvedValue([{ question: "next?", rationale: "" }]) };
        quiz = {
            pose: jest.fn().mockResolvedValue({
                question: "Quick check — what triggers the weekly run?",
                modelAnswer: "The scheduler daemon.",
                keyPoints: ["daemon"],
            }),
            assess: jest.fn().mockResolvedValue("You got the daemon part."),
        };
        knowledgeBase = { retrieve: jest.fn().mockResolvedValue([{ content: "c", location: "s3://b/a.md" }]) };
        registry = { load: jest.fn().mockResolvedValue({ projects: [smile] }) };
        digest = { shouldRefresh: jest.fn().mockReturnValue(false), refresh: jest.fn() };
        store = new InMemoryConversationStore();
        stores = { get: jest.fn().mockResolvedValue(store) };
        config = {};
        chooser = { choose: jest.fn() };
        // The flow picks its own session, so tests read back whichever one it used.
        loadCurrent = async () => {
            const [latest] = await store.findRecentSessionIds(getOwnerId(), 1);
            return store.load(ref(latest));
        };

        flow = new AnswerFlowService(
            classifier,
            router,
            planner,
            writer,
            verify,
            followUps,
            quiz,
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
        expect(writer.general).not.toHaveBeenCalled();
    });

    it("answers a general question without narrowing it to a project", async () => {
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.GENERAL_TECHNICAL,
            projectHints: [],
            resolvedQuestion: "what is idempotency?",
            reasoning: "",
        });

        const result = await flow.ask("what is idempotency?", chooser);

        expect(result.answer).toBe("general answer");
        // The corpus is still consulted — see "general questions checked against the corpus" —
        // but a general question is never routed to, or filtered by, one project.
        expect(router.route).not.toHaveBeenCalled();
        expect(writer.describe).not.toHaveBeenCalled();
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
        expect(writer.describe).not.toHaveBeenCalled();
        expect(writer.general).not.toHaveBeenCalled();
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
        expect(writer.describe).not.toHaveBeenCalled();
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
            statedGoal: "exploring",
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
        await store.appendTurn(ref("s1"), {
            index: 0,
            question: "how does the ARAP data mart work?",
            answer: "long answer",
            answerGist: "ARAP uses double-entry for receivables and payables",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "smile",
            retrievedChunkIds: [],
            createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
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
        expect(writer.describe).not.toHaveBeenCalled();
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
        await store.saveActiveProject(ref("s1"), "smile");
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            statedGoal: "exploring",
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

    it("asks a clarifying question instead of answering from the wrong documents", async () => {
        // The bug this guards: "do we use Lambda?" retrieved documents about the Llama API and
        // the answer opened with "Yes, we are using Lambda functions".
        verify.screen.mockResolvedValueOnce({
            verdict: "wrong_subject",
            missing: "No document mentions AWS Lambda; the matches are about the Llama API.",
            alternativeQuestions: [
                "Which AWS services does the DE Framework integrate with?",
                "Where do we run serverless workloads?",
            ],
        });

        const result = await flow.ask("do any projects use lambda?", chooser);

        expect(result.clarification?.questions).toHaveLength(2);
        expect(result.answer).toBe("");
        expect(writer.describe).not.toHaveBeenCalled();
        expect(followUps.suggest).not.toHaveBeenCalled();
    });

    it("does not record a turn for a clarification, so the reply is a fresh question", async () => {
        verify.screen.mockResolvedValueOnce({
            verdict: "wrong_subject",
            missing: "nothing covers rollback",
            alternativeQuestions: ["How is the MRF pipeline rolled back?"],
        });

        await flow.ask("how do I roll back?", chooser);

        expect((await store.load(ref("s1"))).turns).toHaveLength(0);
    });

    it("answers anyway when the gate objects but offers no usable question", async () => {
        verify.screen.mockResolvedValueOnce({
            verdict: "wrong_subject",
            missing: "partial coverage",
            alternativeQuestions: [],
        });

        const result = await flow.ask("how do refunds work?", chooser);

        expect(result.clarification).toBeUndefined();
        expect(result.answer).toBe("mentor answer");
    });

    it("greets briefly instead of dumping a conversation recap", async () => {
        // "hi" used to be classified as a recap request and printed the last five questions.
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.SMALL_TALK,
            projectHints: [],
            crossProject: false,
            resolvedQuestion: "hi",
            reasoning: "",
        });

        const result = await flow.ask("hi", chooser);

        expect(result.answer).toContain("SMILE");
        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
        expect(writer.describe).not.toHaveBeenCalled();
    });

    it("never asks for clarification twice in a row", async () => {
        // The bug this guards: each suggested rephrasing failed the gate in turn, walking the user
        // through eight rounds of questions without ever producing an answer.
        verify.screen.mockResolvedValue({
            verdict: "wrong_subject",
            missing: "not covered",
            alternativeQuestions: ["a sharper question?"],
        });

        const first = await flow.ask("how does SMILE work?", chooser);
        expect(first.clarification).toBeDefined();

        const second = await flow.ask("a sharper question?", chooser, { allowClarification: false });

        expect(second.clarification).toBeUndefined();
        expect(second.answer).toBe("mentor answer");
    });

    it("gives each run its own session instead of reusing the last one", async () => {
        await store.appendTurn(ref("earlier-session"), {
            index: 0,
            question: "what i need to know to get into mrf project",
            answer: "a",
            answerGist: "MRF uses DB2, ADF, Airflow and PostgreSQL",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "mrf",
            retrievedChunkIds: [],
            createdAt: new Date().toISOString(),
        });

        await flow.ask("so what tech stacks are used", chooser);

        const sessions = await store.findRecentSessionIds(getOwnerId(), 5);
        expect(sessions).toHaveLength(2);
        expect(sessions).not.toEqual(["earlier-session"]);
        // The new turn belongs to the new session, not the earlier one.
        expect((await store.load(ref("earlier-session"))).turns).toHaveLength(1);
    });

    it("carries the owner's recent turns into a fresh terminal as context", async () => {
        // The bug this guards: a new terminal answered "so what tech stacks are used" without the
        // MRF context from the previous run, and pulled documents from an unrelated project.
        await store.appendTurn(ref("earlier-session"), {
            index: 0,
            question: "what i need to know to get into mrf project",
            answer: "a",
            answerGist: "MRF uses DB2, ADF, Airflow and PostgreSQL",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "mrf",
            retrievedChunkIds: [],
            createdAt: new Date().toISOString(),
        });

        await flow.ask("so what tech stacks are used", chooser);

        const [{ recentTurns }] = classifier.classify.mock.calls[0];
        expect(recentTurns.map((t: any) => t.question)).toContain("what i need to know to get into mrf project");
    });

    it("seeds the project from the previous session so a follow-up stays on topic", async () => {
        await store.appendTurn(ref("earlier-session"), {
            index: 0,
            question: "tell me about mrf",
            answer: "a",
            answerGist: "g",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "mrf",
            retrievedChunkIds: [],
            createdAt: new Date().toISOString(),
        });
        await store.saveActiveProject(ref("earlier-session"), "mrf");

        await flow.ask("so what tech stacks are used", chooser);

        expect(router.route).toHaveBeenCalledWith(expect.objectContaining({ activeProject: "mrf" }));
    });

    it("starts clean with no carried context when a new session is requested", async () => {
        await store.appendTurn(ref("earlier-session"), {
            index: 0,
            question: "tell me about mrf",
            answer: "a",
            answerGist: "g",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "mrf",
            retrievedChunkIds: [],
            createdAt: new Date().toISOString(),
        });

        flow.startNewSession();
        await flow.ask("what is idempotency?", chooser);

        const [{ recentTurns }] = classifier.classify.mock.calls[0];
        expect(recentTurns).toHaveLength(0);
    });

    it("recalls the previous conversation when this one has only just started", async () => {
        await store.appendTurn(ref("older"), {
            index: 0,
            question: "what bugs were in the generator?",
            answer: "a",
            answerGist: "twenty bugs across the synthetic data generator",
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            resolvedProject: "saturam",
            retrievedChunkIds: [],
            createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        });
        classifier.classify.mockResolvedValueOnce({
            intent: QuestionIntent.CONVERSATION,
            projectHints: [],
            crossProject: false,
            resolvedQuestion: "what did we discuss last time?",
            reasoning: "",
        });

        const result = await flow.ask("what did we discuss last time?", chooser);

        expect(result.answer).toContain("earlier conversation");
        expect(result.answer).toContain("twenty bugs");
    });

    it("persists the turn with its gist and makes the project sticky", async () => {
        await flow.ask("how do refunds work?", chooser);

        const session = await loadCurrent();
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

        const session = await loadCurrent();
        expect(session.digest?.summary).toBe("s");
    });

    it("still answers when retrieval fails but the router's probe already returned chunks", async () => {
        const probeChunks = [{ content: "from the probe", location: "s3://b/probe.md" }];
        router.route.mockResolvedValue({ kind: "resolved", project: smile, probeChunks });
        knowledgeBase.retrieve.mockRejectedValueOnce(new Error("bedrock down"));

        const result = await flow.ask("how do refunds work?", chooser);

        expect(result.answer).toBe("mentor answer");
        expect(result.chunks).toEqual(probeChunks);
        expect(result.coverage).toBe(AnswerCoverage.DOCUMENTED);
    });

    describe("answers assembled in code", () => {
        const ask = (intent: QuestionIntent, question: string) => {
            classifier.classify.mockResolvedValue({
                intent,
                projectHints: [],
                crossProject: false,
                resolvedQuestion: question,
                reasoning: "",
            });
            return flow.ask(question, chooser);
        };

        it("spends no model call beyond the classifier on a greeting", async () => {
            await ask(QuestionIntent.SMALL_TALK, "hi");

            // No model wrote the greeting and no document backs it, so there is nothing to
            // summarise.
            expect(followUps.suggest).not.toHaveBeenCalled();
            expect(writer.summarize).not.toHaveBeenCalled();
        });

        it("offers the indexed projects instead of model-invented follow-ups", async () => {
            const result = await ask(QuestionIntent.SMALL_TALK, "hi");

            expect(result.followUps).toEqual([{ question: "Tell me about SMILE", rationale: "" }]);
        });

        it("offers projects after a corpus question too", async () => {
            const result = await ask(QuestionIntent.META, "what can you tell me about?");

            expect(result.followUps).toEqual([{ question: "Tell me about SMILE", rationale: "" }]);
            expect(followUps.suggest).not.toHaveBeenCalled();
        });

        it("offers nothing to follow after a recap, which would talk over itself", async () => {
            const result = await ask(QuestionIntent.CONVERSATION, "what did we cover?");

            expect(result.followUps).toEqual([]);
        });

        it("suggests nothing rather than something generic when no project is indexed", async () => {
            registry.load.mockResolvedValue({ projects: [] });

            const result = await ask(QuestionIntent.SMALL_TALK, "hi");

            expect(result.followUps).toEqual([]);
        });

        it("still records the turn, with a gist written in code", async () => {
            await ask(QuestionIntent.META, "what can you tell me about?");

            const session = await loadCurrent();
            expect(session.turns[0].answerGist).toBe("listed the projects currently indexed");
        });

        it("keeps the full batch for an answer a model actually wrote", async () => {
            await flow.ask("how do refunds work?", chooser);

            expect(followUps.suggest).toHaveBeenCalled();
            expect(writer.summarize).toHaveBeenCalled();
        });
    });

    describe("general questions checked against the corpus", () => {
        const askGeneral = (question = "how should retries be handled?") => {
            classifier.classify.mockResolvedValue({
                intent: QuestionIntent.GENERAL_TECHNICAL,
                projectHints: [],
                crossProject: false,
                resolvedQuestion: question,
                reasoning: "",
            });
            return flow.ask(question, chooser);
        };

        it("searches our documentation even though the classifier called the question general", async () => {
            await askGeneral();

            expect(knowledgeBase.retrieve).toHaveBeenCalled();
        });

        it("hands what it found to the general answerer, so it can show how we actually do it", async () => {
            const chunks = [{ content: "we retry twice then dead-letter", location: "s3://b/retry.md" }];
            knowledgeBase.retrieve.mockResolvedValue(chunks);

            const result = await askGeneral();

            expect(writer.general).toHaveBeenCalledWith(expect.objectContaining({ chunks }));
            expect(result.coverage).toBe(AnswerCoverage.BLENDED);
            expect(result.chunks).toEqual(chunks);
        });

        it("answers generally when the corpus has nothing on it", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            const result = await askGeneral();

            expect(writer.general).toHaveBeenCalledWith(expect.objectContaining({ chunks: [] }));
            expect(result.coverage).toBe(AnswerCoverage.NOT_APPLICABLE);
        });

        it("skips the search entirely when nothing is indexed", async () => {
            registry.load.mockResolvedValue({ projects: [] });

            const result = await askGeneral();

            expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
            expect(result.answer).toBe("general answer");
        });

        it("still answers generally when the knowledge base is unreachable", async () => {
            knowledgeBase.retrieve.mockRejectedValue(new Error("bedrock down"));

            const result = await askGeneral();

            // The explanation never depended on retrieval, so a broken corpus must not withhold it.
            expect(result.answer).toBe("general answer");
            expect(result.coverage).toBe(AnswerCoverage.NOT_APPLICABLE);
        });

        it("never routes a general question to a project", async () => {
            await askGeneral();

            expect(router.route).not.toHaveBeenCalled();
            expect(writer.describe).not.toHaveBeenCalled();
        });
    });

    describe("change and impact questions", () => {
        const askChange = (question = "what do I change to move the schedule to Friday?") => {
            classifier.classify.mockResolvedValue({
                intent: QuestionIntent.CHANGE_IMPACT,
                projectHints: [],
                crossProject: false,
                resolvedQuestion: question,
                reasoning: "",
            });
            return flow.ask(question, chooser);
        };

        it("plans several searches instead of searching the question once", async () => {
            await askChange();

            expect(planner.plan).toHaveBeenCalled();
            expect(knowledgeBase.retrieve).toHaveBeenCalledTimes(2);
            expect(knowledgeBase.retrieve).toHaveBeenCalledWith("where configured", expect.anything());
            expect(knowledgeBase.retrieve).toHaveBeenCalledWith("what triggers it", expect.anything());
        });

        it("scopes every planned search to the routed project", async () => {
            await askChange();

            for (const call of knowledgeBase.retrieve.mock.calls) {
                expect(call[1]).toMatchObject({ project: "smile" });
            }
        });

        it("answers with a change plan rather than a description", async () => {
            const result = await askChange();

            expect(writer.advise).toHaveBeenCalled();
            expect(writer.describe).not.toHaveBeenCalled();
            expect(result.answer).toBe("change plan");
        });

        it("gives the planner the previous turn, so a follow-up change question stands alone", async () => {
            await flow.ask("how does the scheduler work?", chooser);
            await askChange("and how would I change it to Friday?");

            expect(planner.plan).toHaveBeenCalledWith(expect.objectContaining({ priorSubject: "gist" }));
        });

        it("ranks a document several searches agree on above one only a single search found", async () => {
            knowledgeBase.retrieve
                .mockResolvedValueOnce([
                    { content: "only in the first search", location: "s3://b/one.md", score: 0.9 },
                    { content: "found by both", location: "s3://b/both.md", score: 0.4 },
                ])
                .mockResolvedValueOnce([{ content: "found by both", location: "s3://b/both.md", score: 0.5 }]);

            const result = await askChange();

            expect(result.chunks.map((c) => c.location)).toEqual(["s3://b/both.md", "s3://b/one.md"]);
        });

        it("keeps every chunk of the same document, since one document arrives as many chunks", async () => {
            knowledgeBase.retrieve
                .mockResolvedValueOnce([
                    { content: "first half of the page", location: "s3://b/same.md", score: 0.7 },
                    { content: "second half of the page", location: "s3://b/same.md", score: 0.6 },
                ])
                .mockResolvedValueOnce([]);

            const result = await askChange();

            expect(result.chunks).toHaveLength(2);
        });

        it("still answers when only some of the planned searches fail", async () => {
            knowledgeBase.retrieve
                .mockRejectedValueOnce(new Error("bedrock down"))
                .mockResolvedValueOnce([{ content: "survived", location: "s3://b/ok.md" }]);

            const result = await askChange();

            expect(result.answer).toBe("change plan");
            expect(result.chunks).toEqual([{ content: "survived", location: "s3://b/ok.md" }]);
        });

        it("refuses rather than planning a change from nothing when every search fails", async () => {
            knowledgeBase.retrieve.mockRejectedValue(new Error("bedrock down"));

            const result = await askChange();

            expect(writer.advise).not.toHaveBeenCalled();
            expect(result.coverage).toBe(AnswerCoverage.NOT_DOCUMENTED);
            expect(result.answer).toContain("could not reach the knowledge base");
        });

        it("refuses when the searches succeed but find nothing", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            const result = await askChange();

            expect(writer.advise).not.toHaveBeenCalled();
            expect(result.coverage).toBe(AnswerCoverage.NOT_DOCUMENTED);
        });

        it("keeps a change question on one project even when the classifier marks it cross-project", async () => {
            classifier.classify.mockResolvedValue({
                intent: QuestionIntent.CHANGE_IMPACT,
                projectHints: [],
                crossProject: true,
                resolvedQuestion: "what do I change everywhere?",
                reasoning: "",
            });

            await flow.ask("what do I change everywhere?", chooser);

            // You change one system at a time — routing must still run.
            expect(router.route).toHaveBeenCalled();
            expect(writer.advise).toHaveBeenCalledWith(expect.objectContaining({ projectDisplayName: "SMILE" }));
        });
    });

    describe("orientation — ask before answering when the goal is unclear", () => {
        const project = {
            intent: QuestionIntent.PROJECT_KNOWLEDGE,
            projectHints: ["SMILE"],
            crossProject: false,
            statedGoal: "",
            resolvedQuestion: "tell me about SMILE",
            reasoning: "",
        };
        beforeEach(() => {
            registry.findByName = jest.fn().mockResolvedValue([smile]);
        });
        const askProject = (question = "tell me about SMILE") => {
            classifier.classify.mockResolvedValue({ ...project, resolvedQuestion: question });
            return flow.ask(question, chooser);
        };

        it("asks why they are here before answering the first project question", async () => {
            const result = await askProject();

            expect(result.orientation).toEqual({
                prompt: expect.stringContaining("SMILE"),
                options: ORIENTATION_OPTIONS,
            });
            expect(result.stage).toBe(LearnerStage.FIRST_CONTACT);
            expect(result.answer).toBe("");
            expect(writer.describe).not.toHaveBeenCalled();
            expect(router.route).not.toHaveBeenCalled();
        });

        it("records nothing for the orientation itself", async () => {
            await askProject();

            expect(await store.findRecentSessionIds(getOwnerId(), 1)).toEqual([]);
        });

        it("answers once the goal is set, and hands the goal and stage to the writer", async () => {
            await askProject();
            await flow.setLearnerGoal("Getting it running");

            const result = await askProject();

            expect(result.orientation).toBeUndefined();
            expect(result.answer).toBe("mentor answer");
            expect(writer.describe).toHaveBeenCalledWith(
                expect.objectContaining({ learnerGoal: "Getting it running", stage: LearnerStage.ORIENTING }),
            );
        });

        it("never asks when the goal was stated in the question itself", async () => {
            classifier.classify.mockResolvedValue({ ...project, statedGoal: "prepare for on-call" });

            const result = await flow.ask("I'm on call next week — tell me about SMILE", chooser);

            expect(result.orientation).toBeUndefined();
            expect(writer.describe).toHaveBeenCalledWith(
                expect.objectContaining({ learnerGoal: "prepare for on-call" }),
            );
        });

        it("never asks for a change question — the change is the goal", async () => {
            classifier.classify.mockResolvedValue({ ...project, intent: QuestionIntent.CHANGE_IMPACT });

            const result = await flow.ask("how do I move the job to Friday?", chooser);

            expect(result.orientation).toBeUndefined();
            expect(writer.advise).toHaveBeenCalled();
        });

        it("never asks for a general question", async () => {
            classifier.classify.mockResolvedValue({
                ...project,
                intent: QuestionIntent.GENERAL_TECHNICAL,
                projectHints: [],
            });

            const result = await flow.ask("what is idempotency?", chooser);

            expect(result.orientation).toBeUndefined();
            expect(result.answer).toBe("general answer");
        });

        it("asks only once in a session", async () => {
            await askProject();
            await flow.setLearnerGoal("Just exploring");
            await askProject();
            writer.describe.mockClear();

            const result = await askProject("and how does it fail?");

            expect(result.orientation).toBeUndefined();
            expect(writer.describe).toHaveBeenCalled();
        });

        it("carries the goal into a later session so it is never asked twice", async () => {
            await askProject();
            await flow.setLearnerGoal("Getting it running");
            await askProject();

            // A new process over the same store: fresh flow, new session id.
            const later = new AnswerFlowService(
                classifier,
                router,
                planner,
                writer,
                verify,
                followUps,
                quiz,
                knowledgeBase,
                registry,
                digest,
                stores,
                config,
            );
            writer.describe.mockClear();

            const result = await later.ask("tell me about SMILE", chooser);

            expect(result.orientation).toBeUndefined();
            expect(result.stage).toBe(LearnerStage.RETURNING);
            expect(writer.describe).toHaveBeenCalledWith(
                expect.objectContaining({ learnerGoal: "Getting it running" }),
            );
        });
    });

    describe("stage", () => {
        it("moves from first contact, through orienting, to deepening as turns accumulate", async () => {
            await flow.ask("how do refunds work?", chooser);
            await flow.ask("and why?", chooser);
            await flow.ask("what breaks?", chooser);

            const stages = writer.describe.mock.calls.map((call: any[]) => call[0].stage);
            expect(stages).toEqual([LearnerStage.FIRST_CONTACT, LearnerStage.ORIENTING, LearnerStage.DEEPENING]);
        });

        it("tells the follow-up generator the stage and goal too", async () => {
            await flow.ask("how do refunds work?", chooser);

            expect(followUps.suggest).toHaveBeenCalledWith(
                expect.objectContaining({
                    stage: LearnerStage.FIRST_CONTACT,
                    learnerGoal: "understanding how it works",
                }),
            );
        });
    });

    describe("comprehension checks", () => {
        it("poses a check from the menu entry without spending a classifier call", async () => {
            await flow.ask("how do refunds work?", chooser);
            classifier.classify.mockClear();

            const result = await flow.ask(QUIZ_MENU_TEXT, chooser);

            expect(classifier.classify).not.toHaveBeenCalled();
            expect(quiz.pose).toHaveBeenCalled();
            expect(result.intent).toBe(QuestionIntent.QUIZ);
            expect(result.answer).toBe("Quick check — what triggers the weekly run?");
            expect(result.followUps).toEqual([]);
        });

        it("treats the next input as the answer and gives feedback, offering another check", async () => {
            await flow.ask("how do refunds work?", chooser);
            await flow.ask(QUIZ_MENU_TEXT, chooser);
            classifier.classify.mockClear();

            const result = await flow.ask("the daemon does it", chooser);

            expect(classifier.classify).not.toHaveBeenCalled();
            expect(quiz.assess).toHaveBeenCalledWith(expect.objectContaining({ learnerAnswer: "the daemon does it" }));
            expect(result.answer).toBe("You got the daemon part.");
            expect(result.followUps).toEqual([{ question: QUIZ_MENU_TEXT, rationale: "" }]);
        });

        it("goes back to normal questions once the check is answered", async () => {
            await flow.ask("how do refunds work?", chooser);
            await flow.ask(QUIZ_MENU_TEXT, chooser);
            await flow.ask("the daemon", chooser);
            classifier.classify.mockClear();

            await flow.ask("and how does it fail?", chooser);

            expect(classifier.classify).toHaveBeenCalled();
        });

        it("does not record the check as turns of the conversation", async () => {
            await flow.ask("how do refunds work?", chooser);
            await flow.ask(QUIZ_MENU_TEXT, chooser);
            await flow.ask("the daemon", chooser);

            const session = await loadCurrent();
            expect(session.turns).toHaveLength(1);
        });

        it("poses a check when the classifier recognises the request in free text", async () => {
            classifier.classify.mockResolvedValue({
                intent: QuestionIntent.QUIZ,
                projectHints: [],
                crossProject: false,
                statedGoal: "",
                resolvedQuestion: "quiz me",
                reasoning: "",
            });

            const result = await flow.ask("quiz me on this", chooser);

            expect(quiz.pose).toHaveBeenCalled();
            expect(result.intent).toBe(QuestionIntent.QUIZ);
        });

        it("says so when there is nothing to check yet, and stays out of quiz mode", async () => {
            quiz.pose.mockRejectedValue(new Error("nothing to check"));

            const result = await flow.ask(QUIZ_MENU_TEXT, chooser);
            classifier.classify.mockClear();
            await flow.ask("how do refunds work?", chooser);

            expect(result.answer).toContain("ask me a couple of things first");
            expect(quiz.assess).not.toHaveBeenCalled();
            expect(classifier.classify).toHaveBeenCalled();
        });

        it("offers a check every fourth written turn", async () => {
            const results = [];
            for (const q of ["one", "two", "three", "four"]) results.push(await flow.ask(q, chooser));

            const offered = results.map((r) => r.followUps.some((f) => f.question === QUIZ_MENU_TEXT));
            expect(offered).toEqual([false, false, false, true]);
        });

        it("drops a pending check when a new session is started", async () => {
            await flow.ask("how do refunds work?", chooser);
            await flow.ask(QUIZ_MENU_TEXT, chooser);

            flow.startNewSession();
            await flow.ask("how do refunds work?", chooser);

            expect(quiz.assess).not.toHaveBeenCalled();
        });
    });

    describe("silent guards on written answers", () => {
        it("revises once when the answer names a file the sources never mention", async () => {
            knowledgeBase.retrieve.mockResolvedValue([
                { content: "The daemon runs cons.sh weekly.", location: "s3://b/a.md" },
            ]);
            writer.describe.mockResolvedValue("Edit `mrf_scheduler/table_scheduler.py`, then run cons.sh.");

            const result = await flow.ask("how do refunds work?", chooser);

            expect(writer.revise).toHaveBeenCalledWith(
                expect.objectContaining({ unsupported: expect.arrayContaining(["mrf_scheduler/table_scheduler.py"]) }),
            );
            expect(result.answer).toBe("revised answer");
        });

        it("leaves an answer alone when every identifier is in the sources", async () => {
            knowledgeBase.retrieve.mockResolvedValue([
                { content: "The daemon runs cons.sh weekly.", location: "s3://b/a.md" },
            ]);
            writer.describe.mockResolvedValue("Run cons.sh on Sunday.");

            const result = await flow.ask("how do refunds work?", chooser);

            expect(writer.revise).not.toHaveBeenCalled();
            expect(result.answer).toBe("Run cons.sh on Sunday.");
        });

        it("counts what was said earlier in the conversation as support", async () => {
            knowledgeBase.retrieve
                .mockResolvedValueOnce([{ content: "The reset lives in table_scheduler.py.", location: "s3://b/a.md" }])
                .mockResolvedValueOnce([{ content: "unrelated", location: "s3://b/b.md" }]);
            writer.describe
                .mockResolvedValueOnce("The reset lives in table_scheduler.py.")
                .mockResolvedValueOnce("As we saw, `table_scheduler.py` runs first.");

            await flow.ask("how do refunds work?", chooser);
            await flow.ask("and then?", chooser);

            expect(writer.revise).not.toHaveBeenCalled();
        });

        it("keeps the original when the revision itself fails", async () => {
            knowledgeBase.retrieve.mockResolvedValue([{ content: "nothing relevant", location: "s3://b/a.md" }]);
            writer.describe.mockResolvedValue("Edit `nowhere/missing.py`.");
            writer.revise.mockRejectedValue(new Error("model unavailable"));

            const result = await flow.ask("how do refunds work?", chooser);

            expect(result.answer).toBe("Edit `nowhere/missing.py`.");
        });

        it("redacts a credential before it is shown or stored", async () => {
            writer.describe.mockResolvedValue("Connect with AKIAIOSFODNN7EXAMPLE and go.");

            const result = await flow.ask("how do refunds work?", chooser);

            expect(result.answer).toBe("Connect with [redacted] and go.");
            expect((await loadCurrent()).turns[0].answer).toBe("Connect with [redacted] and go.");
        });
    });

    describe("guardrails", () => {
        it("refuses to answer from an empty retrieval instead of letting the model fill the gap", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            const result = await flow.ask("what is the kubernetes autoscaling policy?", chooser);

            expect(writer.describe).not.toHaveBeenCalled();
            expect(result.coverage).toBe(AnswerCoverage.NOT_DOCUMENTED);
            expect(result.answer).toContain("could not find anything");
            expect(result.answer).toContain("not going to guess");
        });

        it("names the project it searched, and what else is indexed, so the refusal is actionable", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            const result = await flow.ask("what is the kubernetes autoscaling policy?", chooser);

            expect(result.answer).toContain("SMILE");
        });

        it("distinguishes a broken knowledge base from one that simply has nothing", async () => {
            router.route.mockResolvedValue({ kind: "resolved", project: smile, probeChunks: [] });
            knowledgeBase.retrieve.mockRejectedValue(new Error("bedrock down"));

            const result = await flow.ask("how do refunds work?", chooser);

            expect(writer.describe).not.toHaveBeenCalled();
            expect(result.answer).toContain("could not reach the knowledge base");
            expect(result.answer).toContain("try again");
            // Nothing was searched, so listing the corpus would imply a search that never happened.
            expect(result.answer).not.toContain("Indexed right now");
        });

        it("refuses on an empty retrieval even when a clarification was already offered", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            // allowClarification:false is the "never two clarifications in a row" rule. It must not
            // become a licence to answer a question nothing was retrieved for.
            const result = await flow.ask("something absent", chooser, { allowClarification: false });

            expect(writer.describe).not.toHaveBeenCalled();
            expect(result.coverage).toBe(AnswerCoverage.NOT_DOCUMENTED);
        });
    });
});
