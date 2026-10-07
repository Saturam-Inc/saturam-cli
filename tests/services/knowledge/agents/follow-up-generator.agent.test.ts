import { FollowUpGeneratorAgent } from "../../../../src/services/knowledge/agents/follow-up-generator.agent";

const scheduler = { location: "s3://docs/scheduler.md", metadata: { title: "Scheduler", project: "orion" } };
const alerting = { location: "s3://docs/alerting.md", metadata: { title: "Alerting", project: "orion" } };

/** Two chunks of one document and one of another: two numbered documents, three chunks. */
const chunks = [
    { content: "The scheduler reads the jobs table every minute.", ...scheduler },
    { content: "Retries are capped at three.", ...scheduler },
    { content: "Alerts go to the on-call channel.", ...alerting },
];

describe("FollowUpGeneratorAgent", () => {
    let structured: any;
    let knowledgeBase: any;
    let agent: FollowUpGeneratorAgent;
    const params = {
        question: "how does the scheduler work?",
        answer: "It reads a jobs table.",
        chunks,
        projectSlug: "orion",
    };

    beforeEach(() => {
        structured = { invoke: jest.fn().mockResolvedValue({ followUps: [] }) };
        knowledgeBase = {
            retrieve: jest.fn().mockResolvedValue([{ content: "the jobs table", location: "s3://docs/scheduler.md" }]),
        };
        agent = new FollowUpGeneratorAgent(structured, knowledgeBase);
    });

    it("offers nothing when nothing was retrieved, without asking the model", async () => {
        expect(await agent.suggest({ ...params, chunks: [] })).toEqual([]);
        expect(structured.invoke).not.toHaveBeenCalled();
    });

    it("lists the retrieved documents numbered, one entry per document rather than per chunk", async () => {
        await agent.suggest(params);

        const text = structured.invoke.mock.calls[0][0].messages.map((m: any) => String(m.content)).join("\n");
        expect(text).toContain("[1] Scheduler");
        expect(text).toContain("[2] Alerting");
        expect(text).not.toContain("[3]");
    });

    it("keeps an entry that cites a listed document and that the knowledge base answers", async () => {
        structured.invoke.mockResolvedValue({
            followUps: [{ question: "What happens when a job fails?", sourceIndex: 1, rationale: "retries" }],
        });

        expect(await agent.suggest(params)).toEqual([
            { question: "What happens when a job fails?", rationale: "retries" },
        ]);
        expect(knowledgeBase.retrieve).toHaveBeenCalledWith(
            "What happens when a job fails?",
            expect.objectContaining({ project: "orion" }),
        );
    });

    it("drops an entry that cites no document", async () => {
        structured.invoke.mockResolvedValue({ followUps: [{ question: "How is billing reconciled?", rationale: "" }] });

        expect(await agent.suggest(params)).toEqual([]);
        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
    });

    it("drops an entry that cites a document number not on the list", async () => {
        structured.invoke.mockResolvedValue({ followUps: [{ question: "Where do alerts go?", sourceIndex: 3 }] });
        expect(await agent.suggest(params)).toEqual([]);

        structured.invoke.mockResolvedValue({ followUps: [{ question: "Where do alerts go?", sourceIndex: 2 }] });
        expect(await agent.suggest(params)).toHaveLength(1);
    });

    it("drops an entry whose best matches are not among the documents the answer drew on", async () => {
        knowledgeBase.retrieve.mockResolvedValue([{ content: "invoices", location: "s3://docs/billing.md" }]);
        structured.invoke.mockResolvedValue({
            followUps: [{ question: "How is billing reconciled?", sourceIndex: 1 }],
        });

        expect(await agent.suggest(params)).toEqual([]);
    });

    it("keeps an entry when the knowledge-base check itself fails", async () => {
        knowledgeBase.retrieve.mockRejectedValue(new Error("throttled"));
        structured.invoke.mockResolvedValue({
            followUps: [{ question: "What happens when a job fails?", sourceIndex: 1 }],
        });

        expect(await agent.suggest(params)).toHaveLength(1);
    });

    it("offers at most three", async () => {
        structured.invoke.mockResolvedValue({
            followUps: Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i}?`, sourceIndex: 1 })),
        });

        expect(await agent.suggest(params)).toHaveLength(3);
    });

    it("offers nothing when the model call fails", async () => {
        structured.invoke.mockRejectedValue(new Error("model down"));
        expect(await agent.suggest(params)).toEqual([]);
    });
});
