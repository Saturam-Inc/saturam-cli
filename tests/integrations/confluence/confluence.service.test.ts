import { ConfluenceService } from "../../../src/integrations/confluence/services/confluence.service";
import { ConfigService } from "../../../src/services/config-service";

// ---------------------------------------------------------------------------
// ConfluenceService — Unit Tests
// The service is a pure API client. It returns raw ConfluencePageApiResponse
// objects (Confluence Storage Format XHTML). No HtmlNormalizerService is injected.
// ---------------------------------------------------------------------------

describe("ConfluenceService", () => {
    let service: ConfluenceService;
    let mockConfigService: jest.Mocked<ConfigService>;
    let originalFetch: typeof fetch;

    beforeAll(() => {
        originalFetch = global.fetch;
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    beforeEach(() => {
        mockConfigService = {
            getConfluenceCredentials: jest.fn(),
        } as any;
        service = new ConfluenceService(mockConfigService);
    });

    // --- Helper ---
    const mockFetchOk = (data: unknown) => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(data),
        }) as any;
    };

    const mockFetchFail = (status: number, statusText: string, body = "") => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status,
            statusText,
            text: jest.fn().mockResolvedValue(body),
        }) as any;
    };

    const basicCredentials = { email: "test@example.com", token: "token123" };
    const bearerCredentials = { token: "pat_token_456" };

    // ---------------------------------------------------------------------------
    // getPage
    // ---------------------------------------------------------------------------
    describe("getPage", () => {
        it("returns raw ConfluencePageApiResponse with body.storage.value (Basic auth)", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            const mockResponse = {
                id: "12345",
                title: "My Confluence Page",
                body: {
                    storage: { value: "<h1>My Title</h1><p>Welcome</p>" },
                },
                version: { number: 3, when: "2024-01-01T10:00:00Z" },
                space: { key: "ENG" },
                metadata: { labels: { results: [{ name: "onboarding" }] } },
            };
            mockFetchOk(mockResponse);

            const result = await service.getPage("https://my-company.atlassian.net", "12345");

            expect(result.title).toBe("My Confluence Page");
            // Raw XHTML body — NOT converted to Markdown
            expect(result.body?.storage?.value).toBe("<h1>My Title</h1><p>Welcome</p>");
            expect(result.version?.number).toBe(3);
            expect(result.space?.key).toBe("ENG");
            expect(result.metadata?.labels?.results?.[0]?.name).toBe("onboarding");

            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("/wiki/rest/api/content/12345");
            expect(calledUrl).toContain("body.storage");
        });

        it("returns raw response using Bearer auth when no email is provided", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(bearerCredentials);
            mockFetchOk({ id: "9999", title: "Bearer Page" });

            const result = await service.getPage("https://confluence.myhost.com", "9999");

            expect(result.title).toBe("Bearer Page");
            const calledHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
            expect(calledHeaders.Authorization).toContain("Bearer pat_token_456");
        });

        it("throws on non-ok response", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(bearerCredentials);
            mockFetchFail(404, "Not Found", "Page does not exist");

            await expect(service.getPage("https://my-company.atlassian.net", "0000")).rejects.toThrow(
                "Failed to fetch Confluence page 0000: 404 Not Found - Page does not exist",
            );
        });
    });

    // ---------------------------------------------------------------------------
    // getPageMetadata
    // ---------------------------------------------------------------------------
    describe("getPageMetadata", () => {
        it("fetches without body.storage expansion — no body.storage.value in result", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            // API returns no body when body.storage is not expanded
            mockFetchOk({
                id: "12345",
                title: "Metadata Only",
                version: { number: 5, when: "2024-06-01T00:00:00Z", by: { displayName: "Alice" } },
                space: { key: "ENG", name: "Engineering" },
            });

            const result = await service.getPageMetadata("https://my-company.atlassian.net", "12345");

            expect(result.title).toBe("Metadata Only");
            expect(result.version?.number).toBe(5);
            expect(result.version?.by?.displayName).toBe("Alice");
            // body should be absent / undefined — not requested
            expect(result.body).toBeUndefined();

            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            // body.storage must NOT be in the expand parameter
            expect(calledUrl).not.toContain("body.storage");
            expect(calledUrl).toContain("version");
            expect(calledUrl).toContain("metadata.labels");
        });
    });

    // ---------------------------------------------------------------------------
    // listChildPages
    // ---------------------------------------------------------------------------
    describe("listChildPages", () => {
        it("returns child pages list for a given parent", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            mockFetchOk({
                results: [
                    { id: "201", title: "Child Page A" },
                    { id: "202", title: "Child Page B" },
                ],
                size: 2,
            });

            const result = await service.listChildPages("https://my-company.atlassian.net", "100");

            expect(result.results).toHaveLength(2);
            expect(result.results?.[0]?.id).toBe("201");
            expect(result.results?.[1]?.title).toBe("Child Page B");

            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("/content/100/child/page");
        });
    });

    // ---------------------------------------------------------------------------
    // listSpaces
    // ---------------------------------------------------------------------------
    describe("listSpaces", () => {
        it("returns list of accessible spaces", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            mockFetchOk({
                results: [
                    { key: "ENG", name: "Engineering" },
                    { key: "DOCS", name: "Documentation" },
                ],
                size: 2,
            });

            const result = await service.listSpaces("https://my-company.atlassian.net");

            expect(result.results).toHaveLength(2);
            expect(result.results?.[0]?.key).toBe("ENG");
            expect(result.results?.[1]?.name).toBe("Documentation");

            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("/wiki/rest/api/space");
        });
    });

    // ---------------------------------------------------------------------------
    // listPagesInSpace
    // ---------------------------------------------------------------------------
    describe("listPagesInSpace", () => {
        it("returns raw content list for the given space key", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            const pageChunk = {
                results: [
                    { id: "101", title: "Page One" },
                    { id: "102", title: "Page Two" },
                ],
                size: 2,
            };
            mockFetchOk(pageChunk);

            const result = await service.listPagesInSpace("https://my-company.atlassian.net", "ENG");

            expect(result.results).toEqual([
                { id: "101", title: "Page One" },
                { id: "102", title: "Page Two" },
            ]);

            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("spaceKey=ENG");
            expect(calledUrl).toContain("type=page");
        });
    });

    // ---------------------------------------------------------------------------
    // searchContent (CQL)
    // ---------------------------------------------------------------------------
    describe("searchContent", () => {
        it("runs CQL query and returns raw results in the /rest/api/search envelope", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            // /rest/api/search wraps page data under .content — different from /rest/api/content
            mockFetchOk({
                results: [
                    {
                        content: { id: "301", title: "Onboarding Guide", type: "page" },
                        title: "Onboarding Guide",
                        excerpt: "This guide covers onboarding steps...",
                        resultGlobalContainer: { title: "Engineering", displayUrl: "/spaces/ENG" },
                        lastModified: "2024-06-01T10:00:00.000Z",
                    },
                ],
                size: 1,
                totalSize: 1,
            });

            const cql = `space = "ENG" AND label = "onboarding"`;
            const result = await service.searchContent("https://my-company.atlassian.net", cql);

            // Page data is under .content, not directly on the result item
            expect(result.results?.[0]?.content?.id).toBe("301");
            expect(result.results?.[0]?.content?.title).toBe("Onboarding Guide");
            // Space and excerpt are on the envelope, not inside .content
            // NOTE: Confluence Cloud does NOT return a top-level 'space' field on search results.
            // Space info is derived from resultGlobalContainer.displayUrl ("/spaces/<KEY>").
            expect(result.results?.[0]?.resultGlobalContainer?.title).toBe("Engineering");
            expect(result.results?.[0]?.excerpt).toBe("This guide covers onboarding steps...");
            expect(result.results?.[0]?.lastModified).toBe("2024-06-01T10:00:00.000Z");

            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            // Uses /search (not /content/search — the latter is deprecated in Confluence Cloud)
            expect(calledUrl).toContain("/rest/api/search");
            expect(calledUrl).toContain(encodeURIComponent(cql));
        });

        it("throws on non-ok CQL response", async () => {
            mockConfigService.getConfluenceCredentials.mockResolvedValue(basicCredentials);
            mockFetchFail(400, "Bad Request", "Invalid CQL");

            await expect(
                service.searchContent("https://my-company.atlassian.net", "invalid cql !!!"),
            ).rejects.toThrow("Failed to run Confluence CQL search: 400 Bad Request");
        });
    });
});
