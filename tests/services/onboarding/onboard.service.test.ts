import { OnboardService } from "../../../src/services/onboarding/onboard.service";
import { ConfluenceService } from "../../../src/integrations/confluence/services/confluence.service";
import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../../../src/services/config-service";
import { AdfNormalizerService } from "../../../src/services/onboarding/adf-normalizer.service";
import { HtmlNormalizerService } from "../../../src/services/onboarding/html-normalizer.service";
import { mkdir, writeFile } from "fs/promises";
import { KnowledgeDocument } from "../../../src/services/onboarding/knowledge-source.model";

jest.mock("fs/promises", () => ({
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
}));

describe("OnboardService", () => {
    let service: OnboardService;
    let mockConfluence: jest.Mocked<ConfluenceService>;
    let mockJira: jest.Mocked<JiraService>;
    let mockGoogleDrive: jest.Mocked<GoogleDriveService>;
    let mockConfig: jest.Mocked<ConfigService>;
    let adfNormalizer: AdfNormalizerService;
    let htmlNormalizer: HtmlNormalizerService;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConfluence = {
            getPage: jest.fn(),
            getPageMetadata: jest.fn(),
            listChildPages: jest.fn(),
            listSpaces: jest.fn(),
            listPagesInSpace: jest.fn(),
            searchContent: jest.fn(),
        } as any;
        mockJira = {
            getIssue: jest.fn(),
            getIssueMetadata: jest.fn(),
            searchIssueKeys: jest.fn(),
            searchIssues: jest.fn(),
            listChildIssues: jest.fn(),
            listProjects: jest.fn(),
            listBoards: jest.fn(),
            getBoardBacklogIssues: jest.fn(),
        } as any;
        mockGoogleDrive = {
            getFileMetadata: jest.fn(),
            getGoogleDoc: jest.fn(),
            exportGoogleDocAsMarkdown: jest.fn(),
            exportGoogleDocAsHtml: jest.fn(),
            getFileBinary: jest.fn(),
            listFilesInFolder: jest.fn(),
            searchFiles: jest.fn(),
            getSpreadsheetData: jest.fn(),
            getSpreadsheetMetadata: jest.fn(),
            batchGetSpreadsheetValues: jest.fn(),
        } as any;
        mockConfig = {
            getPersonalConfigPath: jest.fn().mockReturnValue("/mock/personal/config.json"),
        } as any;
        adfNormalizer = new AdfNormalizerService();
        htmlNormalizer = new HtmlNormalizerService();

        service = new OnboardService(
            mockConfluence,
            mockJira,
            mockGoogleDrive,
            mockConfig,
            adfNormalizer,
            htmlNormalizer,
        );
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("sync Confluence pages", () => {
        it("should call confluence.getPage and save content", async () => {
            const config = {
                confluence: {
                    baseUrl: "https://confluence.example.com",
                    pages: ["123"],
                },
            };
            const mockPage = {
                id: "123",
                title: "Test Confluence Page",
                body: {
                    storage: { value: "<p>Hello World</p>" },
                },
                version: { number: 1, when: "2026-07-16T00:00:00Z" },
                space: { key: "TST" },
            };
            mockConfluence.getPage.mockResolvedValue(mockPage);

            await service.sync(config, "/mock/cwd");

            expect(mockConfluence.getPage).toHaveBeenCalledWith("https://confluence.example.com", "123");
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });

        it("should paginate confluence.listPagesInSpace when resolving space pages", async () => {
            const config = {
                confluence: {
                    baseUrl: "https://confluence.example.com",
                    spaces: ["TST"],
                },
            };

            const firstResult = {
                results: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}` })),
            };
            const secondResult = {
                results: [],
            };
            mockConfluence.listPagesInSpace
                .mockResolvedValueOnce(firstResult as any)
                .mockResolvedValueOnce(secondResult as any);

            mockConfluence.getPage.mockResolvedValue({
                id: "id-0",
                title: "Mocked Page",
                body: { storage: { value: "Hello" } },
                version: { number: 1 },
                space: { key: "TST" },
            } as any);

            await service.sync(config, "/mock/cwd");

            expect(mockConfluence.listPagesInSpace).toHaveBeenCalledTimes(2);
            expect(mockConfluence.listPagesInSpace).toHaveBeenNthCalledWith(
                1,
                "https://confluence.example.com",
                "TST",
                { start: 0, limit: 100 }
            );
            expect(mockConfluence.listPagesInSpace).toHaveBeenNthCalledWith(
                2,
                "https://confluence.example.com",
                "TST",
                { start: 100, limit: 100 }
            );
        });
    });

    describe("sync Jira tickets", () => {
        it("should call jira.getIssue and save content", async () => {
            const config = {
                jira: {
                    baseUrl: "https://jira.example.com",
                    tickets: ["TST-101"],
                },
            };
            const mockIssue = {
                id: "1000",
                key: "TST-101",
                fields: {
                    summary: "Jira Ticket Summary",
                    status: { name: "To Do" },
                    description: {
                        type: "doc",
                        content: [{ type: "paragraph", content: [{ type: "text", text: "Ticket details" }] }],
                    },
                },
            };
            mockJira.getIssue.mockResolvedValue(mockIssue);

            await service.sync(config, "/mock/cwd");

            expect(mockJira.getIssue).toHaveBeenCalledWith("https://jira.example.com", "TST-101");
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });

        it("should paginate jira.searchIssues when resolving JQL query tickets", async () => {
            const config = {
                projects: {
                    "my-project": {
                        jira: {
                            baseUrl: "https://jira.example.com",
                            jql: "project = TST",
                        },
                    },
                },
            };

            const firstResult = {
                total: 150,
                issues: Array.from({ length: 100 }, (_, i) => ({ key: `TST-${i}` })),
            };
            const secondResult = {
                total: 150,
                issues: Array.from({ length: 50 }, (_, i) => ({ key: `TST-${100 + i}` })),
            };

            mockJira.searchIssues
                .mockResolvedValueOnce(firstResult as any)
                .mockResolvedValueOnce(secondResult as any);

            mockJira.getIssue.mockResolvedValue({
                id: "1000",
                key: "TST-0",
                fields: {
                    summary: "Jira Ticket",
                    status: { name: "To Do" },
                },
            } as any);

            await service.sync(config as any, "/mock/cwd");

            expect(mockJira.searchIssues).toHaveBeenCalledTimes(2);
            expect(mockJira.searchIssues).toHaveBeenNthCalledWith(
                1,
                "https://jira.example.com",
                "project = TST",
                { startAt: 0, maxResults: 100 }
            );
            expect(mockJira.searchIssues).toHaveBeenNthCalledWith(
                2,
                "https://jira.example.com",
                "project = TST",
                { startAt: 100, maxResults: 100 }
            );
        });
    });

    describe("sync Google Docs", () => {
        it("should fetch native Google Doc and save exported markdown", async () => {
            const config = {
                googleDocs: {
                    docs: ["doc-id-xyz"],
                },
            };
            const mockMeta = {
                name: "Google Doc Title",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-07-16T00:00:00Z",
                owners: [{ displayName: "Test User" }],
            };
            mockGoogleDrive.getFileMetadata.mockResolvedValue(mockMeta);
            mockGoogleDrive.exportGoogleDocAsMarkdown.mockResolvedValue("# Document Content");

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getFileMetadata).toHaveBeenCalledWith("doc-id-xyz");
            expect(mockGoogleDrive.exportGoogleDocAsMarkdown).toHaveBeenCalledWith("doc-id-xyz");
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });
    });

    describe("sync Google Sheets", () => {
        it("should fetch cell values and save sidecar json", async () => {
            const config = {
                googleSheets: {
                    spreadsheetId: "sheet-id-abc",
                    range: "Sheet1!A:E",
                },
            };
            const mockMeta = {
                spreadsheetId: "sheet-id-abc",
                title: "Spreadsheet Title",
                sheets: [{ properties: { title: "Sheet1" } }],
            } as any;
            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue(mockMeta);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    { range: "Sheet1!A:E", values: [["header1"], ["row1"]] },
                ],
            });

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("sheet-id-abc");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("sheet-id-abc", ["Sheet1!A:E"]);
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });
    });
});
