import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { ConfigService } from "../../../src/services/config-service";

describe("JiraService", () => {
    let service: JiraService;
    let mockConfigService: jest.Mocked<ConfigService>;

    beforeEach(() => {
        mockConfigService = {
            getJiraCredentials: jest.fn(),
        } as any;
        service = new JiraService(mockConfigService);
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
                expect.stringMatching(/^https:\/\/saturam\.atlassian\.net\/rest\/api\/3\/issue\/ENG-101\?fields=/),
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
                "https://saturam.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20ENG&maxResults=100&fields=summary%2Cstatus%2Cassignee%2Cpriority%2Cissuetype%2Clabels",
                expect.objectContaining({
                    headers: {
                        Accept: "application/json",
                        Authorization: "Bearer bearer-token-val",
                    },
                }),
            );
        });

        it("should auto-paginate using nextPageToken in listAllIssuesByJql", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "bearer-token-val" });

            const firstPageResponse = {
                issues: [{ key: "ENG-201" }, { key: "ENG-202" }],
                nextPageToken: "token-page-2",
            };
            const secondPageResponse = {
                issues: [{ key: "ENG-203" }],
                nextPageToken: undefined,
            };

            const mockFetch = jest
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue(firstPageResponse),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue(secondPageResponse),
                });
            global.fetch = mockFetch as any;

            const result = await service.listAllIssuesByJql("https://saturam.atlassian.net", "project = ENG");

            expect(result).toEqual(["ENG-201", "ENG-202", "ENG-203"]);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch).toHaveBeenNthCalledWith(
                1,
                "https://saturam.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20ENG&maxResults=100&fields=summary%2Cstatus%2Cassignee%2Cpriority%2Cissuetype%2Clabels",
                expect.any(Object),
            );
            expect(mockFetch).toHaveBeenNthCalledWith(
                2,
                "https://saturam.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20ENG&maxResults=100&fields=summary%2Cstatus%2Cassignee%2Cpriority%2Cissuetype%2Clabels&nextPageToken=token-page-2",
                expect.any(Object),
            );
        });
    });

    describe("listAllComments", () => {
        let originalFetch: typeof fetch;

        beforeAll(() => {
            originalFetch = global.fetch;
        });

        afterAll(() => {
            global.fetch = originalFetch;
        });

        it("auto-paginates until every comment (per the reported total) has been fetched", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "bearer-token-val" });

            const mockFetch = jest
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        comments: [{ id: "1" }, { id: "2" }],
                        total: 3,
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue({
                        comments: [{ id: "3" }],
                        total: 3,
                    }),
                });
            global.fetch = mockFetch as any;

            const result = await service.listAllComments("https://saturam.atlassian.net", "ENG-1");

            expect(result).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch).toHaveBeenNthCalledWith(
                1,
                "https://saturam.atlassian.net/rest/api/3/issue/ENG-1/comment?startAt=0&maxResults=100",
                expect.any(Object),
            );
            expect(mockFetch).toHaveBeenNthCalledWith(
                2,
                "https://saturam.atlassian.net/rest/api/3/issue/ENG-1/comment?startAt=2&maxResults=100",
                expect.any(Object),
            );
        });

        it("stops when a page returns no comments even if total looks larger", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "bearer-token-val" });
            const mockFetch = jest.fn().mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ comments: [], total: 3 }),
            });
            global.fetch = mockFetch as any;

            const result = await service.listAllComments("https://saturam.atlassian.net", "ENG-1");

            expect(result).toEqual([]);
            expect(mockFetch).toHaveBeenCalledTimes(1);
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

        it("should build JQL query using parent to fetch children", async () => {
            mockConfigService.getJiraCredentials.mockResolvedValue({ token: "bearer-token-val" });

            const mockSearchResponse = {
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
                "https://saturam.atlassian.net/rest/api/3/search/jql?jql=parent%20%3D%20ENG-101&maxResults=100&fields=summary%2Cstatus%2Cassignee%2Cpriority%2Cissuetype%2Clabels",
                expect.objectContaining({
                    headers: {
                        Accept: "application/json",
                        Authorization: "Bearer bearer-token-val",
                    },
                }),
            );
        });

        it("should throw error for invalid parentKey format", async () => {
            await expect(
                service.listChildIssues("https://saturam.atlassian.net", "invalid_key; DELETE"),
            ).rejects.toThrow("Invalid Jira issue key format");
        });
    });
});
