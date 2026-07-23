import { ConfluenceKnowledgeSource } from "../../../src/services/knowledge/confluence-knowledge.source";
import { ConfluenceService } from "../../../src/integrations/confluence/services/confluence.service";
import { HtmlNormalizerService } from "../../../src/services/normalizers/html-normalizer.service";

describe("ConfluenceKnowledgeSource", () => {
    let source: ConfluenceKnowledgeSource;
    let mockConfluence: jest.Mocked<ConfluenceService>;
    let html: HtmlNormalizerService;

    beforeEach(() => {
        mockConfluence = {
            getPage: jest.fn(),
        } as any;
        html = new HtmlNormalizerService();
        source = new ConfluenceKnowledgeSource(mockConfluence, html);
    });

    it("should return a KnowledgeDocument with correct fields", async () => {
        mockConfluence.getPage.mockResolvedValue({
            id: "12345",
            title: "Architecture Overview",
            body: {
                storage: { value: "<p>This is the architecture.</p>" },
            },
            version: { number: 3, when: "2026-06-15", by: { displayName: "Dave" } },
            space: { key: "ARCH" },
            metadata: {
                labels: { results: [{ name: "architecture" }, { name: "design" }] },
            },
        } as any);

        const doc = await source.fetch("12345", { baseUrl: "https://example.atlassian.net" });

        expect(doc.id).toBe("12345");
        expect(doc.source).toBe("confluence");
        expect(doc.title).toBe("Architecture Overview");
        expect(doc.url).toContain("/wiki/spaces/ARCH/pages/12345");
        expect(doc.content).toContain("# Architecture Overview");
        expect(doc.content).toContain("This is the architecture.");
        expect(doc.metadata.labels).toEqual(["architecture", "design"]);
        expect(doc.metadata.author).toBe("Dave");
        expect(doc.metadata.updatedAt).toBe("2026-06-15");
    });

    it("should use '_No Content_' when body is empty", async () => {
        mockConfluence.getPage.mockResolvedValue({
            id: "99",
            title: "Empty Page",
            body: { storage: { value: "" } },
            version: { number: 1 },
            space: { key: "TST" },
            metadata: { labels: { results: [] } },
        } as any);

        const doc = await source.fetch("99", { baseUrl: "https://example.atlassian.net" });

        expect(doc.content).toContain("_No Content_");
    });

    it("should throw if id is missing", async () => {
        await expect(source.fetch("", { baseUrl: "https://example.atlassian.net" })).rejects.toThrow(
            "Confluence page ID is missing or invalid.",
        );
    });

    it("should throw if baseUrl is missing", async () => {
        await expect(source.fetch("12345", {})).rejects.toThrow(
            "No base URL configured for Confluence page: 12345",
        );
    });
});
