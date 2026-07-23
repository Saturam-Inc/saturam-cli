import { JiraKnowledgeSource } from "../../../src/services/knowledge/jira-knowledge.source";
import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { AdfNormalizerService } from "../../../src/services/normalizers/adf-normalizer.service";

describe("JiraKnowledgeSource", () => {
    let source: JiraKnowledgeSource;
    let mockJira: jest.Mocked<JiraService>;
    let adf: AdfNormalizerService;

    beforeEach(() => {
        mockJira = {
            getIssue: jest.fn(),
        } as any;
        adf = new AdfNormalizerService();
        source = new JiraKnowledgeSource(mockJira, adf);
    });

    it("should return a KnowledgeDocument with correct fields", async () => {
        mockJira.getIssue.mockResolvedValue({
            key: "TST-1",
            fields: {
                summary: "Fix login bug",
                status: { name: "In Progress" },
                assignee: { displayName: "Alice" },
                reporter: { displayName: "Bob" },
                priority: { name: "High" },
                issuetype: { name: "Bug" },
                created: "2026-01-01",
                updated: "2026-07-01",
                labels: ["auth", "critical"],
                description: {
                    type: "doc",
                    content: [
                        {
                            type: "paragraph",
                            content: [{ type: "text", text: "Login fails on Safari." }],
                        },
                    ],
                },
                comment: { comments: [] },
            },
        } as any);

        const doc = await source.fetch("TST-1", { baseUrl: "https://jira.example.com" });

        expect(doc.id).toBe("TST-1");
        expect(doc.source).toBe("jira");
        expect(doc.title).toBe("Fix login bug");
        expect(doc.url).toBe("https://jira.example.com/browse/TST-1");
        expect(doc.content).toContain("# [TST-1] Fix login bug");
        expect(doc.content).toContain("Login fails on Safari.");
        expect(doc.metadata.labels).toEqual(["auth", "critical"]);
        expect(doc.metadata.author).toBe("Bob");
        expect(doc.metadata.updatedAt).toBe("2026-07-01");
    });

    it("should render comments when present", async () => {
        mockJira.getIssue.mockResolvedValue({
            key: "TST-2",
            fields: {
                summary: "Another issue",
                status: { name: "Open" },
                labels: [],
                comment: {
                    comments: [
                        {
                            author: { displayName: "Carol" },
                            created: "2026-07-01T10:00:00Z",
                            body: {
                                type: "doc",
                                content: [
                                    { type: "paragraph", content: [{ type: "text", text: "LGTM!" }] },
                                ],
                            },
                        },
                    ],
                },
            },
        } as any);

        const doc = await source.fetch("TST-2", { baseUrl: "https://jira.example.com" });

        expect(doc.content).toContain("Comment by Carol");
        expect(doc.content).toContain("LGTM!");
    });

    it("should throw if id is missing", async () => {
        await expect(source.fetch("", { baseUrl: "https://jira.example.com" })).rejects.toThrow(
            "Jira ticket key is missing or invalid.",
        );
    });

    it("should throw if baseUrl is missing", async () => {
        await expect(source.fetch("TST-1", {})).rejects.toThrow(
            "No base URL configured for Jira ticket: TST-1",
        );
    });
});
