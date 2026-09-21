import { ProjectRegistryService } from "../../../src/services/knowledge/project-registry.service";

describe("ProjectRegistryService", () => {
    let s3: any;
    let config: any;
    let service: ProjectRegistryService;

    const registryJson = JSON.stringify({
        generatedAt: "2026-09-17T10:00:00Z",
        projects: [
            {
                slug: "smile",
                displayName: "SMILE",
                aliases: ["smile app"],
                documentCount: 42,
                summary: "Refunds portal",
                sources: ["confluence"],
            },
            { slug: "billing-core", displayName: "Billing Core", aliases: [], sources: [] },
        ],
    });

    beforeEach(() => {
        s3 = { getStateObject: jest.fn().mockResolvedValue(Buffer.from(registryJson)) };
        config = { getPersonalConfigPath: jest.fn().mockReturnValue("/nonexistent/sateng/config.json") };
        service = new ProjectRegistryService(s3, config);
    });

    it("loads the registry the ingestion pipeline wrote to S3", async () => {
        const { projects } = await service.load();

        expect(projects.map((p) => p.slug)).toEqual(["smile", "billing-core"]);
    });

    it("reads registry.json from the state prefix, where the pipeline writes it", async () => {
        await service.load();

        // Not getObject: the content prefix is what Bedrock ingests, and registry.json is
        // deliberately kept out of it.
        expect(s3.getStateObject).toHaveBeenCalledWith("registry.json");
    });

    it("caches the registry so every question does not pay an S3 round trip", async () => {
        await service.load();
        await service.load();

        expect(s3.getStateObject).toHaveBeenCalledTimes(1);
    });

    it("returns an empty registry rather than throwing when S3 and the local sync both fail", async () => {
        s3.getStateObject.mockRejectedValue(new Error("no such key"));

        const { projects } = await service.load();

        expect(projects).toEqual([]);
    });

    it("matches a project by slug, display name, or alias", async () => {
        await expect(service.findByName("SMILE")).resolves.toHaveLength(1);
        await expect(service.findByName("smile app")).resolves.toHaveLength(1);
        await expect(service.findByName("Billing Core")).resolves.toHaveLength(1);
        await expect(service.findByName("nothing")).resolves.toHaveLength(0);
    });

    it("matches case- and punctuation-insensitively, the way users actually type names", async () => {
        await expect(service.findByName("billing core")).resolves.toMatchObject([{ slug: "billing-core" }]);
        await expect(service.findByName("BILLING-CORE")).resolves.toMatchObject([{ slug: "billing-core" }]);
    });

    it("renders a catalogue carrying aliases and summaries for the prompts", async () => {
        const described = await service.describeForPrompt();

        expect(described).toContain("SMILE [slug: smile]");
        expect(described).toContain("also called: smile app");
        expect(described).toContain("Refunds portal");
    });

    it("tells the prompt plainly when nothing is indexed", async () => {
        s3.getStateObject.mockRejectedValue(new Error("no such key"));

        await expect(service.describeForPrompt()).resolves.toBe("(no projects are indexed yet)");
    });
});
