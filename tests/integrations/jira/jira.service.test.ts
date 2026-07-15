import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { AdfNormalizerService } from "../../../src/services/onboarding/adf-normalizer.service";
import { ConfigService } from "../../../src/services/config-service";

describe("JiraService", () => {
    let service: JiraService;
    let adfNormalizer: AdfNormalizerService;
    let mockConfigService: jest.Mocked<ConfigService>;

    beforeEach(() => {
        mockConfigService = {
            getJiraCredentials: jest.fn(),
        } as any;
        adfNormalizer = new AdfNormalizerService();
        // JiraService no longer depends on AdfNormalizerService
        service = new JiraService(mockConfigService);
    });

    // ADF rendering tests remain on AdfNormalizerService directly (correct ownership)
    describe("AdfNormalizerService.renderAdfNode", () => {
        it("should render plain paragraph text", () => {
            const adf = {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text: "Hello Jira!" }],
                    },
                ],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toBe("Hello Jira!\n");
        });

        it("should render heading level 1 and 2", () => {
            const adf = {
                type: "doc",
                content: [
                    {
                        type: "heading",
                        attrs: { level: 1 },
                        content: [{ type: "text", text: "Main Title" }],
                    },
                    {
                        type: "heading",
                        attrs: { level: 2 },
                        content: [{ type: "text", text: "Sub Section" }],
                    },
                ],
            };
            const md = adfNormalizer.renderAdfNode(adf);
            expect(md).toContain("# Main Title");
            expect(md).toContain("## Sub Section");
        });

        it("should render bold, italic, code, strike, and link marks", () => {
            const adf = {
                type: "paragraph",
                content: [
                    { type: "text", text: "bold text", marks: [{ type: "strong" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "italic text", marks: [{ type: "em" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "inline code", marks: [{ type: "code" }] },
                    { type: "text", text: " " },
                    { type: "text", text: "strikeout", marks: [{ type: "strike" }] },
                    { type: "text", text: " " },
                    {
                        type: "text",
                        text: "Jira link",
                        marks: [{ type: "link", attrs: { href: "https://atlassian.com" } }],
                    },
                ],
            };
            const md = adfNormalizer.renderAdfNode(adf);
            expect(md).toContain("**bold text**");
            expect(md).toContain("*italic text*");
            expect(md).toContain("`inline code`");
            expect(md).toContain("~~strikeout~~");
            expect(md).toContain("[Jira link](https://atlassian.com)");
        });

        it("should render bullet lists", () => {
            const adf = {
                type: "bulletList",
                content: [
                    {
                        type: "listItem",
                        content: [
                            { type: "paragraph", content: [{ type: "text", text: "Bullet Item One" }] },
                        ],
                    },
                ],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toContain("- Bullet Item One");
        });

        it("should render ordered lists with sequential numbering", () => {
            const adf = {
                type: "orderedList",
                content: [
                    {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Step One" }] }],
                    },
                    {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Step Two" }] }],
                    },
                ],
            };
            const md = adfNormalizer.renderAdfNode(adf);
            expect(md).toContain("1. Step One");
            expect(md).toContain("2. Step Two");
        });

        it("should render code blocks", () => {
            const adf = {
                type: "codeBlock",
                attrs: { language: "typescript" },
                content: [{ type: "text", text: "const x = 123;" }],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toContain("```typescript\nconst x = 123;\n```");
        });

        it("should render blockquotes", () => {
            const adf = {
                type: "blockquote",
                content: [
                    { type: "paragraph", content: [{ type: "text", text: "Important notice." }] },
                ],
            };
            expect(adfNormalizer.renderAdfNode(adf)).toContain("> Important notice.");
        });
    });

    // JiraService API client tests — verify raw API responses are returned without conversion
    describe("getIssue", () => {
        let originalFetch: typeof fetch;

        beforeAll(() => {
            originalFetch = global.fetch;
        });

        afterAll(() => {
            global.fetch = originalFetch;
        });

        it("should call the Jira issue endpoint and return raw API response", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({
                email: "test@example.com",
                token: "jira-token-xyz",
            });

            const mockIssueResponse = {
                key: "ENG-101",
                fields: {
                    summary: "Write unit tests",
                    status: { name: "In Progress" },
                    assignee: { displayName: "Developer Vasanth" },
                    priority: { name: "High" },
                    description: {
                        type: "doc",
                        version: 1,
                        content: [
                            {
                                type: "paragraph",
                                content: [{ type: "text", text: "Tests description content" }],
                            },
                        ],
                    },
                    comment: {
                        comments: [
                            {
                                author: { displayName: "Reviewer A" },
                                created: "2026-06-29T12:00:00.000Z",
                                body: {
                                    type: "paragraph",
                                    content: [{ type: "text", text: "Looking good!" }],
                                },
                            },
                        ],
                    },
                },
            };

            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockIssueResponse),
            });
            global.fetch = mockFetch as any;

            const result = await service.getIssue("https://saturam.atlassian.net", "ENG-101");

            // Raw response returned — no ADF conversion, no string-formatted dates
            expect(result.key).toBe("ENG-101");
            expect(result.fields?.summary).toBe("Write unit tests");
            expect(result.fields?.status?.name).toBe("In Progress");
            expect(result.fields?.assignee?.displayName).toBe("Developer Vasanth");
            expect(result.fields?.priority?.name).toBe("High");

            // Description is raw ADF — NOT a Markdown string
            expect(result.fields?.description).toEqual(mockIssueResponse.fields.description);
            expect(typeof result.fields?.description).toBe("object");

            // Comments are raw ADF — NOT pre-formatted strings
            expect(result.fields?.comment?.comments?.[0].body).toEqual(
                mockIssueResponse.fields.comment.comments[0].body,
            );

            expect(mockFetch).toHaveBeenCalledWith(
                "https://saturam.atlassian.net/rest/api/3/issue/ENG-101",
                expect.objectContaining({
                    headers: {
                        Accept: "application/json",
                        Authorization: "Basic dGVzdEBleGFtcGxlLmNvbTpqaXJhLXRva2VuLXh5eg==",
                    },
                }),
            );
        });

        it("should throw an error when the issue endpoint returns a non-ok response", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "some-token" });

            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 404,
                statusText: "Not Found",
                text: jest.fn().mockResolvedValue("Issue not found"),
            }) as any;

            await expect(service.getIssue("https://saturam.atlassian.net", "ENG-999")).rejects.toThrow(
                "Failed to fetch Jira issue ENG-999: 404 Not Found",
            );
        });
    });

    describe("getIssueMetadata", () => {
        let originalFetch: typeof fetch;

        beforeAll(() => {
            originalFetch = global.fetch;
        });

        afterAll(() => {
            global.fetch = originalFetch;
        });

        it("should call the issue endpoint with fields parameter and return raw metadata", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({
                email: "test@example.com",
                token: "jira-token-xyz",
            });

            const mockIssueResponse = {
                key: "ENG-101",
                fields: {
                    summary: "Write unit tests",
                    status: { name: "In Progress" },
                },
            };

            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockIssueResponse),
            });
            global.fetch = mockFetch as any;

            const result = await service.getIssueMetadata("https://saturam.atlassian.net", "ENG-101");

            expect(result.key).toBe("ENG-101");
            expect(result.fields?.summary).toBe("Write unit tests");
            expect(result.fields?.status?.name).toBe("In Progress");

            expect(mockFetch).toHaveBeenCalledWith(
                "https://saturam.atlassian.net/rest/api/3/issue/ENG-101?fields=summary%2Cstatus%2Cassignee%2Creporter%2Cpriority%2Cissuetype%2Ccreated%2Cupdated%2Clabels%2Cproject",
                expect.objectContaining({
                    headers: {
                        Accept: "application/json",
                        Authorization: "Basic dGVzdEBleGFtcGxlLmNvbTpqaXJhLXRva2VuLXh5eg==",
                    },
                }),
            );
        });

        it("should throw an error when the issue metadata endpoint returns a non-ok response", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "some-token" });

            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 403,
                statusText: "Forbidden",
                text: jest.fn().mockResolvedValue("Access denied"),
            }) as any;

            await expect(service.getIssueMetadata("https://saturam.atlassian.net", "ENG-999")).rejects.toThrow(
                "Failed to fetch Jira issue metadata ENG-999: 403 Forbidden",
            );
        });
    });

    describe("searchIssueKeys", () => {
        let originalFetch: typeof fetch;

        beforeAll(() => {
            originalFetch = global.fetch;
        });

        afterAll(() => {
            global.fetch = originalFetch;
        });

        it("should query the search endpoint and return issue keys list", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "bearer-token-val" });

            const mockSearchResponse = {
                total: 2,
                issues: [{ key: "ENG-201" }, { key: "ENG-202" }],
            };

            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockSearchResponse),
            });
            global.fetch = mockFetch as any;

            const result = await service.searchIssueKeys("https://saturam.atlassian.net", "project = ENG");

            expect(result).toEqual(["ENG-201", "ENG-202"]);
            expect(mockFetch).toHaveBeenCalledWith(
                "https://saturam.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20ENG&maxResults=100&startAt=0&fields=summary%2Cstatus%2Cassignee%2Cpriority%2Cissuetype%2Clabels",
                expect.objectContaining({
                    headers: {
                        Accept: "application/json",
                        Authorization: "Bearer bearer-token-val",
                    },
                }),
            );
        });
    });

    describe("listChildIssues", () => {
        let originalFetch: typeof fetch;

        beforeAll(() => {
            originalFetch = global.fetch;
        });

        afterAll(() => {
            global.fetch = originalFetch;
        });

        it("should build JQL query using parent and Epic Link to fetch children", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "bearer-token-val" });

            const mockSearchResponse = {
                total: 1,
                issues: [{ key: "ENG-102" }],
            };

            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockSearchResponse),
            });
            global.fetch = mockFetch as any;

            const result = await service.listChildIssues("https://saturam.atlassian.net", "ENG-101");

            expect(result.issues?.[0].key).toBe("ENG-102");
            expect(mockFetch).toHaveBeenCalledWith(
                "https://saturam.atlassian.net/rest/api/3/search/jql?jql=parent%20%3D%20ENG-101%20OR%20%22Epic%20Link%22%20%3D%20ENG-101&maxResults=100&startAt=0&fields=summary%2Cstatus%2Cassignee%2Cpriority%2Cissuetype%2Clabels",
                expect.objectContaining({
                    headers: {
                        Accept: "application/json",
                        Authorization: "Bearer bearer-token-val",
                    },
                }),
            );
        });
    });
});
