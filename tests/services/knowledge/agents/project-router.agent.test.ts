import { ProjectRouterAgent } from "../../../../src/services/knowledge/agents/project-router.agent";
import { ProjectRegistryService } from "../../../../src/services/knowledge/project-registry.service";
import { BedrockKnowledgeBaseService } from "../../../../src/integrations/aws/services/bedrock-knowledge-base.service";
import { StructuredOutputService } from "../../../../src/services/knowledge/structured-output";

const smile = { slug: "smile", displayName: "SMILE", aliases: ["smile app"], sources: [] };
const billing = { slug: "billing-core", displayName: "Billing Core", aliases: [], sources: [] };

function chunk(project: string, score: number) {
    return { content: "text", score, location: `s3://b/${project}.md`, metadata: { project } };
}

describe("ProjectRouterAgent", () => {
    let registry: jest.Mocked<ProjectRegistryService>;
    let knowledgeBase: jest.Mocked<BedrockKnowledgeBaseService>;
    let structured: jest.Mocked<StructuredOutputService>;
    let agent: ProjectRouterAgent;

    beforeEach(() => {
        registry = {
            findByName: jest.fn().mockResolvedValue([]),
            getBySlug: jest
                .fn()
                .mockImplementation(async (slug: string) => [smile, billing].find((p) => p.slug === slug)),
            describeForPrompt: jest.fn().mockResolvedValue("- SMILE [slug: smile]"),
            load: jest.fn().mockResolvedValue({ projects: [smile, billing] }),
        } as any;
        knowledgeBase = { retrieve: jest.fn().mockResolvedValue([]) } as any;
        structured = { invoke: jest.fn() } as any;
        agent = new ProjectRouterAgent(registry, knowledgeBase, structured);
    });

    it("resolves from an explicit project name without retrieving", async () => {
        (registry.findByName as jest.Mock).mockResolvedValueOnce([smile]);

        const decision = await agent.route({ question: "how does SMILE bill?", projectHints: ["SMILE"] });

        expect(decision).toMatchObject({ kind: "resolved", project: smile });
        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
    });

    it("asks the user when a hint matches more than one project", async () => {
        (registry.findByName as jest.Mock).mockResolvedValueOnce([smile, billing]);

        const decision = await agent.route({ question: "how do refunds work?", projectHints: ["core"] });

        expect(decision.kind).toBe("ambiguous");
    });

    it("falls back to the session's active project when the question names none", async () => {
        const decision = await agent.route({
            question: "and how does it fail?",
            projectHints: [],
            activeProject: "smile",
        });

        expect(decision).toMatchObject({ kind: "resolved", project: smile });
        expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
    });

    it("routes by probe when one project dominates the retrieved chunks", async () => {
        (knowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([
            chunk("smile", 0.9),
            chunk("smile", 0.88),
            chunk("smile", 0.85),
            chunk("billing-core", 0.4),
        ]);

        const decision = await agent.route({ question: "how do refunds work?", projectHints: [] });

        expect(decision).toMatchObject({ kind: "resolved", project: smile });
    });

    it("asks the user when two projects are too close to call", async () => {
        // Even share and a score gap below the margin: exactly the case where guessing is wrong
        // half the time, so the user is asked instead.
        (knowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([
            chunk("smile", 0.9),
            chunk("smile", 0.88),
            chunk("billing-core", 0.89),
            chunk("billing-core", 0.87),
        ]);
        (structured.invoke as jest.Mock).mockResolvedValueOnce({
            candidates: [
                { slug: "smile", confidence: 0.5, why: "" },
                { slug: "billing-core", confidence: 0.5, why: "" },
            ],
            reasoning: "",
        });

        const decision = await agent.route({ question: "how do refunds work?", projectHints: [] });

        expect(decision.kind).toBe("ambiguous");
        if (decision.kind === "ambiguous") {
            expect(decision.candidates.map((c) => c.project.slug).sort()).toEqual(["billing-core", "smile"]);
        }
    });

    it("narrows to one project when the model rules the other out", async () => {
        (knowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([
            chunk("smile", 0.9),
            chunk("smile", 0.88),
            chunk("billing-core", 0.89),
            chunk("billing-core", 0.87),
        ]);
        (structured.invoke as jest.Mock).mockResolvedValueOnce({
            candidates: [{ slug: "smile", confidence: 0.9, why: "refunds live here" }],
            reasoning: "",
        });

        const decision = await agent.route({ question: "how do refunds work?", projectHints: [] });

        expect(decision).toMatchObject({ kind: "resolved", project: smile });
    });

    it("reports no project when retrieval comes back empty", async () => {
        const decision = await agent.route({ question: "what is a monorepo?", projectHints: [] });

        expect(decision.kind).toBe("none");
    });

    it("keeps all candidates when narrowing fails, rather than dropping the question", async () => {
        (knowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([chunk("smile", 0.9), chunk("billing-core", 0.89)]);
        (structured.invoke as jest.Mock).mockRejectedValueOnce(new Error("no tool calling"));

        const decision = await agent.route({ question: "how do refunds work?", projectHints: [] });

        expect(decision.kind).toBe("ambiguous");
    });
});
