import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../../../src/services/config-service";

describe("GoogleDriveService", () => {
    let service: GoogleDriveService;
    let mockConfigService: jest.Mocked<ConfigService>;
    let originalFetch: typeof fetch;

    beforeAll(() => {
        originalFetch = global.fetch;
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfigService = {
            getGoogleAccessToken: jest.fn(),
        } as any;
        service = new GoogleDriveService(mockConfigService);
    });

    const mockFetchOk = (data: any) => {
        const response = {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue(data),
            text: jest.fn().mockResolvedValue(typeof data === "string" ? data : JSON.stringify(data)),
        };
        global.fetch = jest.fn().mockResolvedValue(response) as any;
    };

    const mockFetchFail = (status: number, statusText: string, textContent: string) => {
        const response = {
            ok: false,
            status,
            statusText,
            text: jest.fn().mockResolvedValue(textContent),
        };
        global.fetch = jest.fn().mockResolvedValue(response) as any;
    };

    describe("getFileMetadata", () => {
        it("fetches Google Drive file metadata successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockMeta = {
                id: "docId123",
                name: "Sprint Retrospective",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-07-10T12:00:00.000Z",
                owners: [{ displayName: "Abhinash" }],
            };
            mockFetchOk(mockMeta);

            const result = await service.getFileMetadata("docId123");

            expect(result).toEqual(mockMeta);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("https://www.googleapis.com/drive/v3/files/docId123");
            expect(calledUrl).toContain("fields=");
            expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe("Bearer mock_token_123");
        });

        it("throws an error when metadata fetch fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            mockFetchFail(404, "Not Found", "File not found");

            await expect(service.getFileMetadata("invalidId")).rejects.toThrow(
                "Failed to fetch metadata for file invalidId: 404 Not Found - File not found"
            );
        });
    });

    describe("getGoogleDoc", () => {
        it("fetches Google Docs API v1 structured JSON successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockDoc = {
                documentId: "docId123",
                title: "Structured Document",
                body: { content: [] },
            };
            mockFetchOk(mockDoc);

            const result = await service.getGoogleDoc("docId123");

            expect(result).toEqual(mockDoc);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toBe("https://docs.googleapis.com/v1/documents/docId123");
        });

        it("throws an error when document fetch fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            mockFetchFail(403, "Forbidden", "Permission denied");

            await expect(service.getGoogleDoc("docId123")).rejects.toThrow(
                "Failed to fetch Google Doc docId123: 403 Forbidden - Permission denied"
            );
        });
    });

    describe("exportGoogleDocAsMarkdown", () => {
        it("exports document to markdown string successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const markdownStr = "# Hello World\nThis is markdown.";
            mockFetchOk(markdownStr);

            const result = await service.exportGoogleDocAsMarkdown("docId123");

            expect(result).toBe(markdownStr);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("https://www.googleapis.com/drive/v3/files/docId123/export");
            expect(calledUrl).toContain("mimeType=text%2Fmarkdown");
        });
    });

    describe("exportGoogleDocAsHtml", () => {
        it("exports document to HTML string successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const htmlStr = "<h1>Hello World</h1><p>This is HTML.</p>";
            mockFetchOk(htmlStr);

            const result = await service.exportGoogleDocAsHtml("docId123");

            expect(result).toBe(htmlStr);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("https://www.googleapis.com/drive/v3/files/docId123/export");
            expect(calledUrl).toContain("mimeType=text%2Fhtml");
        });
    });

    describe("listFilesInFolder", () => {
        it("lists files successfully with default options", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockList = {
                files: [{ id: "file1", name: "Doc 1" }],
            };
            mockFetchOk(mockList);

            const result = await service.listFilesInFolder("folder123");

            expect(result).toEqual(mockList);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("https://www.googleapis.com/drive/v3/files");
            // URLSearchParams encodes spaces as +
            expect(calledUrl).toContain("q=%27folder123%27+in+parents+and+trashed+%3D+false");
            expect(calledUrl).toContain("pageSize=100");
        });

        it("lists files successfully with options (limit, mimeType, pageToken)", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockList = {
                files: [{ id: "file2", name: "Doc 2" }],
                nextPageToken: "next_token_456",
            };
            mockFetchOk(mockList);

            const result = await service.listFilesInFolder("folder123", {
                limit: 10,
                mimeType: "application/vnd.google-apps.document",
                pageToken: "token_abc",
            });

            expect(result).toEqual(mockList);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            // URLSearchParams encodes spaces as + and quotes as %27
            expect(calledUrl).toContain("q=%27folder123%27+in+parents+and+trashed+%3D+false+and+mimeType+%3D+%27application%2Fvnd.google-apps.document%27");
            expect(calledUrl).toContain("pageSize=10");
            expect(calledUrl).toContain("pageToken=token_abc");
        });
    });

    describe("getFileBinary", () => {
        it("fetches raw binary content successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockBuffer = new ArrayBuffer(8);
            const response = {
                ok: true,
                arrayBuffer: jest.fn().mockResolvedValue(mockBuffer),
            };
            global.fetch = jest.fn().mockResolvedValue(response) as any;

            const result = await service.getFileBinary("binaryFileId");

            expect(result).toBe(mockBuffer);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toBe("https://www.googleapis.com/drive/v3/files/binaryFileId?alt=media");
        });

        it("throws an error when fetch fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            mockFetchFail(500, "Internal Server Error", "Failure");

            await expect(service.getFileBinary("binaryFileId")).rejects.toThrow(
                "Failed to fetch binary content for file binaryFileId: 500 Internal Server Error - Failure"
            );
        });
    });


    describe("searchFiles", () => {
        it("searches files successfully with standard query and default limit", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockSearchResponse = {
                files: [{ id: "searchResultId", name: "Found File" }],
            };
            mockFetchOk(mockSearchResponse);

            const query = "name contains 'onboarding' and trashed = false";
            const result = await service.searchFiles(query);

            expect(result).toEqual(mockSearchResponse);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("https://www.googleapis.com/drive/v3/files");
            expect(calledUrl).toContain("q=name+contains+%27onboarding%27+and+trashed+%3D+false");
            expect(calledUrl).toContain("pageSize=100");
        });

        it("throws an error when search API fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            mockFetchFail(400, "Bad Request", "Invalid query");

            await expect(service.searchFiles("invalid query")).rejects.toThrow(
                "Failed to search Google Drive files with query \"invalid query\": 400 Bad Request - Invalid query"
            );
        });
    });

    // --- Google Sheets Tests ---

    describe("getSpreadsheetData", () => {
        it("fetches full unrestricted spreadsheet successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockSpreadsheet = {
                spreadsheetId: "sheetId123",
                properties: { title: "Project Index" },
                sheets: [
                    { properties: { title: "Sheet1", sheetId: 0 } }
                ],
            };
            mockFetchOk(mockSpreadsheet);

            const result = await service.getSpreadsheetData("sheetId123");

            expect(result).toEqual(mockSpreadsheet);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheetId123");
            expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe("Bearer mock_token_123");
        });

        it("throws error when spreadsheet fetch fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            mockFetchFail(404, "Not Found", "Spreadsheet not found");

            await expect(service.getSpreadsheetData("sheetId123")).rejects.toThrow(
                "Failed to fetch spreadsheet sheetId123: 404 Not Found - Spreadsheet not found"
            );
        });
    });

    describe("getSpreadsheetMetadata", () => {
        it("fetches unified Drive & Sheets metadata successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");

            const mockDriveResponse = {
                owners: [{ displayName: "Vasanth G" }],
                modifiedTime: "2026-06-09T10:19:08.130Z",
                createdTime: "2026-06-01T10:00:00.000Z",
            };
            const mockSheetsResponse = {
                spreadsheetId: "sheetId123",
                properties: { title: "Project Index" },
                sheets: [
                    { properties: { title: "Sheet1", sheetId: 0, index: 0, gridProperties: { rowCount: 100, columnCount: 10 }, hidden: false } }
                ],
                spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheetId123/edit",
            };

            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue(mockDriveResponse),
                } as any)
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue(mockSheetsResponse),
                } as any);

            const result = await service.getSpreadsheetMetadata("sheetId123");

            expect(result).toEqual({
                spreadsheetId: "sheetId123",
                title: "Project Index",
                spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheetId123/edit",
                owners: [{ displayName: "Vasanth G" }],
                modifiedTime: "2026-06-09T10:19:08.130Z",
                createdTime: "2026-06-01T10:00:00.000Z",
                sheets: [
                    { sheetId: 0, title: "Sheet1", index: 0, rowCount: 100, columnCount: 10, hidden: false }
                ]
            });

            const driveCallUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            const sheetsCallUrl = (global.fetch as jest.Mock).mock.calls[1][0] as string;

            expect(driveCallUrl).toContain("https://www.googleapis.com/drive/v3/files/sheetId123");
            expect(sheetsCallUrl).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheetId123?includeGridData=false");
        });

        it("throws error when Drive fetch fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");

            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    ok: false,
                    status: 400,
                    statusText: "Bad Request",
                    text: jest.fn().mockResolvedValue("Invalid ID"),
                } as any)
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue({}),
                } as any);

            await expect(service.getSpreadsheetMetadata("sheetId123")).rejects.toThrow(
                "Failed to fetch Drive metadata for spreadsheet sheetId123: 400 Bad Request - Invalid ID"
            );
        });

        it("throws error when Sheets fetch fails", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");

            global.fetch = jest.fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: jest.fn().mockResolvedValue({}),
                } as any)
                .mockResolvedValueOnce({
                    ok: false,
                    status: 404,
                    statusText: "Not Found",
                    text: jest.fn().mockResolvedValue("Not found"),
                } as any);

            await expect(service.getSpreadsheetMetadata("sheetId123")).rejects.toThrow(
                "Failed to fetch Sheets metadata for spreadsheet sheetId123: 404 Not Found - Not found"
            );
        });
    });

    describe("batchGetSpreadsheetValues", () => {
        it("batch fetches multiple ranges successfully", async () => {
            mockConfigService.getGoogleAccessToken.mockResolvedValue("mock_token_123");
            const mockBatch = {
                spreadsheetId: "sheetId123",
                valueRanges: [
                    { range: "Sheet1!A1", values: [["Val1"]] },
                    { range: "Sheet2!B2", values: [["Val2"]] }
                ],
            };
            mockFetchOk(mockBatch);

            const result = await service.batchGetSpreadsheetValues("sheetId123", ["Sheet1!A1", "Sheet2!B2"]);

            expect(result).toEqual(mockBatch);
            const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(calledUrl).toContain("https://sheets.googleapis.com/v4/spreadsheets/sheetId123/values:batchGet");
            expect(calledUrl).toContain("ranges=Sheet1!A1");
            expect(calledUrl).toContain("ranges=Sheet2!B2");
        });
    });
});


