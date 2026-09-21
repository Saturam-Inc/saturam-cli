import { AnswerFlowService } from "../../../src/services/knowledge/answer-flow.service";
import { InMemoryConversationStore } from "../../../src/services/knowledge/conversation-store";
import { getOwnerId } from "../../../src/services/knowledge/session-identity";

const project = { slug: "orion", displayName: "Orion", aliases: [], sources: [] };
const ref = (sessionId: string) => ({ ownerId: getOwnerId(), sessionId });

/**
 * These tests cover what the flow still decides, which is deliberately little: it resolves the
 * session, runs the two guards over whatever the agent wrote, and records the turn.
 *
 * The suite this replaced was ~1,100 lines, almost all of it asserting which of nine branches a
 * given intent took. Those assertions went with the branches — what shape an answer takes is now
 * the agent's judgement over real evidence, which is what the eval suite measures, not a unit test.
 */
describe("AnswerFlowService", () => {
    let mentor: any;
    let writer: any;
    let followUps: any;
    let registry: any;
    let digest: any;
    let store: InMemoryConversationStore;
    let stores: any;
    let flow: AnswerFlowService;

    beforeEach(() => {
        mentor = {
            answer: jest.fn().mockResolvedValue({
                answer: "The scheduler reads a jobs table.",
                chunks: [{ content: "jobs table", location: "s3://docs/a.md", metadata: { project: "orion" } }],
                projectSlug: "orion",
            }),
        };
        writer = {
            revise: jest.fn().mockResolvedValue("revised"),
            summarize: jest.fn().mockResolvedValue("explained the scheduler"),
        };
        followUps = { suggest: jest.fn().mockResolvedValue([{ question: "What triggers it?", rationale: "" }]) };
        registry = {
            getBySlug: jest.fn().mockResolvedValue(project),
            load: jest.fn().mockResolvedValue({ projects: [project] }),
        };
        digest = { shouldRefresh: jest.fn().mockReturnValue(false), refresh: jest.fn() };
        store = new InMemoryConversationStore();
        stores = { get: jest.fn().mockResolvedValue(store) };

        flow = new AnswerFlowService(mentor, writer, followUps, registry, digest, stores);
    });

    it("returns the agent's answer with its evidence and follow-ups", async () => {
        const result = await flow.ask("how does the scheduler work?");

        expect(result.answer).toBe("The scheduler reads a jobs table.");
        expect(result.chunks).toHaveLength(1);
        expect(result.followUps).toEqual([{ question: "What triggers it?", rationale: "" }]);
        expect(result.project).toEqual(project);
    });

    it("hands the agent the conversation so far", async () => {
        await flow.ask("how does the scheduler work?");
        await flow.ask("and what triggers it?");

        const second = mentor.answer.mock.calls[1][0];
        expect(second.question).toBe("and what triggers it?");
        expect(second.recentTurns).toHaveLength(1);
        expect(second.recentTurns[0].answerGist).toBe("explained the scheduler");
    });

    it("records the turn, its project and its chunk locations", async () => {
        await flow.ask("how does the scheduler work?");

        const [sessionId] = await store.findRecentSessionIds(getOwnerId(), 1);
        const session = await store.load(ref(sessionId));
        expect(session.turns).toHaveLength(1);
        expect(session.turns[0]).toMatchObject({
            question: "how does the scheduler work?",
            answerGist: "explained the scheduler",
            resolvedProject: "orion",
            retrievedChunkIds: ["s3://docs/a.md"],
        });
        expect(session.activeProject).toBe("orion");
    });

    it("redacts anything credential-shaped the agent wrote", async () => {
        mentor.answer.mockResolvedValue({
            answer: "Set the key to AKIAIOSFODNN7EXAMPLE and restart.",
            chunks: [],
            projectSlug: undefined,
        });

        const result = await flow.ask("how do I authenticate?");
        expect(result.answer).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(result.answer).toContain("[redacted]");
    });

    it("revises once when the answer names a file the sources never mention", async () => {
        mentor.answer.mockResolvedValue({
            answer: "Edit `scripts/totally_made_up.sh` to change it.",
            chunks: [{ content: "the jobs table lives in warehouse.jobs", location: "s3://docs/a.md" }],
            projectSlug: undefined,
        });
        writer.revise.mockResolvedValue("Edit the job configuration; the documentation does not name the script.");

        const result = await flow.ask("what do I edit?");

        expect(writer.revise).toHaveBeenCalledWith(
            expect.objectContaining({ unsupported: expect.arrayContaining(["scripts/totally_made_up.sh"]) }),
        );
        expect(result.answer).toContain("does not name the script");
    });

    it("keeps the original answer when the revision call fails", async () => {
        mentor.answer.mockResolvedValue({
            answer: "Edit `scripts/totally_made_up.sh` to change it.",
            chunks: [{ content: "unrelated", location: "s3://docs/a.md" }],
            projectSlug: undefined,
        });
        writer.revise.mockRejectedValue(new Error("model down"));

        const result = await flow.ask("what do I edit?");
        expect(result.answer).toContain("scripts/totally_made_up.sh");
    });

    it("does not run the identifier check when nothing was retrieved", async () => {
        mentor.answer.mockResolvedValue({ answer: "Nothing is documented.", chunks: [], projectSlug: undefined });

        await flow.ask("what about billing?");
        expect(writer.revise).not.toHaveBeenCalled();
    });

    it("leaves the project unset when the evidence does not agree on one", async () => {
        mentor.answer.mockResolvedValue({ answer: "Both use it.", chunks: [], projectSlug: undefined });

        const result = await flow.ask("which projects use Terraform?");
        expect(result.project).toBeUndefined();
        expect(registry.getBySlug).not.toHaveBeenCalled();
    });

    it("carries the previous session's turns into a new one", async () => {
        await flow.ask("how does the scheduler work?");

        const continued = new AnswerFlowService(mentor, writer, followUps, registry, digest, stores);
        await continued.ask("and what triggers it?");

        const latest = mentor.answer.mock.calls[1][0];
        expect(latest.history.map((turn: any) => turn.question)).toContain("how does the scheduler work?");
    });

    it("starts clean when a new session is requested", async () => {
        await flow.ask("how does the scheduler work?");

        const fresh = new AnswerFlowService(mentor, writer, followUps, registry, digest, stores);
        fresh.startNewSession();
        await fresh.ask("something else entirely");

        expect(mentor.answer.mock.calls[1][0].history).toEqual([]);
    });

    it("refreshes the digest only when the digest service says to", async () => {
        digest.shouldRefresh.mockReturnValue(true);
        digest.refresh.mockResolvedValue({
            summary: "covered the scheduler",
            projectsDiscussed: ["orion"],
            jargonDefined: [],
            questionsAsked: [],
            coversUpToIndex: 1,
        });

        await flow.ask("how does the scheduler work?");

        const [sessionId] = await store.findRecentSessionIds(getOwnerId(), 1);
        expect((await store.load(ref(sessionId))).digest?.summary).toBe("covered the scheduler");
    });
});
