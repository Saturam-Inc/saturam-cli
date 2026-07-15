import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { GOOGLE_DOCS_API, GOOGLE_DRIVE_API, GOOGLE_SHEETS_API } from "../constants/google-drive.constant";
import {
    GoogleDocApiResponse,
    GoogleDriveFileListApiResponse,
    GoogleDriveFileMetadata,
    GoogleSheetBatchValuesApiResponse,
    GoogleSpreadsheetApiResponse,
    GoogleSpreadsheetMetadataResponse,
} from "../models/google-drive.model";

const logger = getLogger("GoogleDriveService");

@Service()
export class GoogleDriveService {
    constructor(private readonly config: ConfigService) { }

    private async getHeaders(): Promise<Record<string, string>> {
        const token = await this.config.getGoogleAccessToken();
        return {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        };
    }

    // --- File Metadata ---

    /**
     * Fetch Drive metadata for any file (Doc, Sheet, DOCX, folder, etc.).
     * Includes name, mimeType, modifiedTime, owners, size, and webViewLink.
     */
    public async getFileMetadata(fileId: string): Promise<GoogleDriveFileMetadata> {
        const fields = "id,name,mimeType,modifiedTime,createdTime,owners,size,webViewLink,webContentLink,parents,trashed";
        const url = `${GOOGLE_DRIVE_API}/files/${fileId}?fields=${encodeURIComponent(fields)}`;

        logger.debug(`Fetching file metadata for ${fileId}: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch metadata for file ${fileId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<GoogleDriveFileMetadata>;
    }

    // --- Document Content ---

    /**
     * Fetch the full structured JSON representation of a Google Doc.
     * Returns the Docs API v1 response — paragraphs, tables, inline objects.
     */
    public async getGoogleDoc(documentId: string): Promise<GoogleDocApiResponse> {
        const url = `${GOOGLE_DOCS_API}/${documentId}`;

        logger.debug(`Fetching Google Doc structured JSON for ${documentId}: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch Google Doc ${documentId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<GoogleDocApiResponse>;
    }

    /**
     * Export a native Google Doc as Markdown text.
     * Only works for mimeType = "application/vnd.google-apps.document".
     */
    public async exportGoogleDocAsMarkdown(documentId: string): Promise<string> {
        const url = `${GOOGLE_DRIVE_API}/files/${documentId}/export?mimeType=${encodeURIComponent("text/markdown")}`;

        logger.debug(`Exporting file ${documentId} as Markdown: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to export file ${documentId} as Markdown: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.text();
    }

    /**
     * Export a native Google Doc as HTML.
     * Only works for mimeType = "application/vnd.google-apps.document".
     */
    public async exportGoogleDocAsHtml(documentId: string): Promise<string> {
        const url = `${GOOGLE_DRIVE_API}/files/${documentId}/export?mimeType=${encodeURIComponent("text/html")}`;

        logger.debug(`Exporting file ${documentId} as HTML: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to export file ${documentId} as HTML: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.text();
    }

    /**
     * Fetch the raw binary content of any non-native file (e.g. .docx, .pdf, images).
     * Returns the raw file bytes as an ArrayBuffer.
     */
    public async getFileBinary(fileId: string): Promise<ArrayBuffer> {
        const url = `${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`;

        logger.debug(`Fetching binary content for file ${fileId} from Drive: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch binary content for file ${fileId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.arrayBuffer();
    }



    // --- File Listing ---

    /**
     * List files inside a Google Drive folder.
     * Returns raw Drive API file list including id, name, mimeType, modifiedTime.
     */
    public async listFilesInFolder(
        folderId: string,
        options?: { limit?: number; pageToken?: string; mimeType?: string },
    ): Promise<GoogleDriveFileListApiResponse> {
        const limit = options?.limit ?? 100;
        let query = `'${folderId}' in parents and trashed = false`;
        if (options?.mimeType) {
            query += ` and mimeType = '${options.mimeType}'`;
        }

        const fields = "nextPageToken,files(id,name,mimeType,modifiedTime,owners,webViewLink,size)";
        const params = new URLSearchParams({
            q: query,
            pageSize: String(limit),
            fields,
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
        });
        if (options?.pageToken) params.set("pageToken", options.pageToken);

        const url = `${GOOGLE_DRIVE_API}/files?${params.toString()}`;

        logger.debug(`Listing files in Drive folder ${folderId}: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to list files in Drive folder ${folderId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<GoogleDriveFileListApiResponse>;
    }

    // --- Search ---

    /**
     * Search files across Google Drive using standard query syntax.
     * Examples:
     *   - `name contains 'onboarding'`
     *   - `mimeType = 'application/vnd.google-apps.folder'`
     *   - `modifiedTime > '2026-01-01T00:00:00Z'`
     */
    public async searchFiles(
        query: string,
        options?: { limit?: number; pageToken?: string },
    ): Promise<GoogleDriveFileListApiResponse> {
        const limit = options?.limit ?? 100;
        const fields = "nextPageToken,files(id,name,mimeType,modifiedTime,owners,webViewLink,size)";
        const params = new URLSearchParams({
            q: query,
            pageSize: String(limit),
            fields,
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
        });
        if (options?.pageToken) params.set("pageToken", options.pageToken);

        const url = `${GOOGLE_DRIVE_API}/files?${params.toString()}`;

        logger.debug(`Searching files with query "${query}": ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to search Google Drive files with query "${query}": ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<GoogleDriveFileListApiResponse>;
    }

    // ─── Google Sheets Operations ───────────────────────────────────────────

    /**
     * Unified spreadsheet metadata fetch.
     * Fetches Drive-level attributes (owner, modifiedTime, createdTime) and
     * Sheets-level structure (spreadsheet properties and sheet tabs list)
     * in parallel and returns a merged response.
     */
    public async getSpreadsheetMetadata(spreadsheetId: string): Promise<GoogleSpreadsheetMetadataResponse> {
        const driveUrl = `${GOOGLE_DRIVE_API}/files/${spreadsheetId}?fields=${encodeURIComponent(
            "owners,modifiedTime,createdTime"
        )}`;
        const sheetsUrl = `${GOOGLE_SHEETS_API}/${spreadsheetId}?includeGridData=false`;

        logger.debug(`Fetching metadata for spreadsheet ${spreadsheetId}`);

        const headers = await this.getHeaders();
        const [driveRes, sheetsRes] = await Promise.all([
            fetch(driveUrl, { headers }),
            fetch(sheetsUrl, { headers }),
        ]);

        if (!driveRes.ok) {
            const text = await driveRes.text();
            throw new Error(
                `Failed to fetch Drive metadata for spreadsheet ${spreadsheetId}: ${driveRes.status} ${driveRes.statusText} - ${text}`,
            );
        }
        if (!sheetsRes.ok) {
            const text = await sheetsRes.text();
            throw new Error(
                `Failed to fetch Sheets metadata for spreadsheet ${spreadsheetId}: ${sheetsRes.status} ${sheetsRes.statusText} - ${text}`,
            );
        }

        const driveData = (await driveRes.json()) as GoogleDriveFileMetadata;
        const sheetsData = (await sheetsRes.json()) as GoogleSpreadsheetApiResponse;

        return {
            spreadsheetId,
            title: sheetsData.properties?.title,
            spreadsheetUrl: sheetsData.spreadsheetUrl,
            owners: driveData.owners,
            modifiedTime: driveData.modifiedTime,
            createdTime: driveData.createdTime,
            sheets: sheetsData.sheets?.map((s) => ({
                sheetId: s.properties?.sheetId,
                title: s.properties?.title,
                index: s.properties?.index,
                rowCount: s.properties?.gridProperties?.rowCount,
                columnCount: s.properties?.gridProperties?.columnCount,
                hidden: s.properties?.hidden,
            })),
        };
    }

    /**
     * Fetch the complete spreadsheet resource.
     * Contains full sheet properties, tabs, and all cell grid/formatting data.
     *
     * WARNING: Calling this on a large spreadsheet can result in massive payloads (10MB+),
     * causing performance bottlenecks. For reading data, use batchGetSpreadsheetValues() instead.
     */
    public async getSpreadsheetData(spreadsheetId: string): Promise<GoogleSpreadsheetApiResponse> {
        const url = `${GOOGLE_SHEETS_API}/${spreadsheetId}`;

        logger.debug(`Fetching complete spreadsheet ${spreadsheetId}: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch spreadsheet ${spreadsheetId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<GoogleSpreadsheetApiResponse>;
    }

    /**
     * Fetch cell values for multiple ranges in a single API call.
     * Can be called with a single range (e.g. ["Class Data"]) or multiple ranges.
     *
     * Examples:
     *   batchGetSpreadsheetValues(id, ["Sheet1"])         → all populated data on Sheet1
     *   batchGetSpreadsheetValues(id, ["Projects!A:D"])   → all rows, columns A-D
     *
     * Returns valueRanges[] in the same order as the requested ranges array.
     */
    public async batchGetSpreadsheetValues(
        spreadsheetId: string,
        ranges: string[],
    ): Promise<GoogleSheetBatchValuesApiResponse> {
        const rangeParams = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
        const url = `${GOOGLE_SHEETS_API}/${spreadsheetId}/values:batchGet?${rangeParams}`;

        logger.debug(`Batch fetching ${ranges.length} range(s) from spreadsheet ${spreadsheetId}: ${url}`);

        const response = await fetch(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to batch fetch values from spreadsheet ${spreadsheetId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<GoogleSheetBatchValuesApiResponse>;
    }
}
