// ---------------------------------------------------------------------------
// Raw Google Drive / Docs / Sheets REST API response shapes.
// ---------------------------------------------------------------------------

// ─── Google Drive (shared) ──────────────────────────────────────────────────

export interface GoogleDriveOwner {
    displayName?: string;
    emailAddress?: string;
    photoLink?: string;
}

/**
 * Raw file metadata from GET /drive/v3/files/{id}.
 * Returned by getFileMetadata().
 */
export interface GoogleDriveFileMetadata {
    id?: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    createdTime?: string;
    owners?: GoogleDriveOwner[];
    /** File size in bytes (not available for native Google Workspace files) */
    size?: string;
    /** Browser URL to open the file */
    webViewLink?: string;
    /** Direct download URL (not available for Google Workspace files) */
    webContentLink?: string;
    parents?: string[];
    trashed?: boolean;
}

/**
 * Raw file list response from GET /drive/v3/files.
 * Returned by listFilesInFolder().
 */
export interface GoogleDriveFileListApiResponse {
    kind?: string;
    nextPageToken?: string;
    incompleteSearch?: boolean;
    files?: GoogleDriveFileMetadata[];
}

// ─── Google Docs API v1 ─────────────────────────────────────────────────────

/**
 * A text run within a paragraph — carries the actual string content.
 */
export interface GoogleDocTextRun {
    content?: string;
    textStyle?: Record<string, unknown>;
}

/**
 * A single element within a paragraph (text run, inline object reference, etc.).
 */
export interface GoogleDocParagraphElement {
    startIndex?: number;
    endIndex?: number;
    textRun?: GoogleDocTextRun;
    inlineObjectElement?: Record<string, unknown>;
    horizontalRule?: Record<string, unknown>;
    footnoteReference?: Record<string, unknown>;
}

/**
 * A paragraph structural element in the document body.
 */
export interface GoogleDocStructuralElement {
    startIndex?: number;
    endIndex?: number;
    paragraph?: {
        elements?: GoogleDocParagraphElement[];
        paragraphStyle?: Record<string, unknown>;
        bullet?: Record<string, unknown>;
    };
    table?: Record<string, unknown>;
    tableOfContents?: Record<string, unknown>;
    sectionBreak?: Record<string, unknown>;
}

/**
 * Full raw response from GET /docs/v1/documents/{documentId}.
 * Returned by getGoogleDoc().
 *
 * Use exportGoogleDocAsMarkdown() or exportGoogleDocAsHtml() for simpler string-based access.
 * Use getGoogleDoc() only when you need fine-grained structural access
 * (e.g., extracting specific paragraphs, tables, or inline objects).
 */
export interface GoogleDocApiResponse {
    documentId?: string;
    title?: string;
    revisionId?: string;
    body?: {
        content?: GoogleDocStructuralElement[];
    };
    documentStyle?: Record<string, unknown>;
    namedStyles?: Record<string, unknown>;
    lists?: Record<string, unknown>;
    inlineObjects?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    footers?: Record<string, unknown>;
}

// ─── Google Sheets API v4 ───────────────────────────────────────────────────

/**
 * Sheet tab properties within a spreadsheet.
 */
export interface GoogleSheetProperties {
    sheetId?: number;
    title?: string;
    index?: number;
    sheetType?: string; // "GRID" | "OBJECT" | "DATA_SOURCE"
    gridProperties?: {
        rowCount?: number;
        columnCount?: number;
        frozenRowCount?: number;
        frozenColumnCount?: number;
    };
    hidden?: boolean;
    tabColorStyle?: Record<string, unknown>;
}

/**
 * A single sheet (tab) within a spreadsheet.
 */
export interface GoogleSheet {
    properties?: GoogleSheetProperties;
    // data is only present when includeGridData=true, not used in metadata calls
    data?: Array<{
        rowData?: Array<{ values?: Array<{ formattedValue?: string }> }>;
        startRow?: number;
        startColumn?: number;
    }>;
}

/**
 * Full raw response from GET /sheets/v4/spreadsheets/{spreadsheetId}.
 * Returned by getSpreadsheet() and getSpreadsheetMetadata().
 */
export interface GoogleSpreadsheetApiResponse {
    spreadsheetId?: string;
    properties?: {
        title?: string;
        locale?: string;
        autoRecalc?: string;
        timeZone?: string;
    };
    sheets?: GoogleSheet[];
    spreadsheetUrl?: string;
}

/**
 * Unified metadata response combining Drive metadata and Sheets metadata.
 * Returned by getSpreadsheetMetadata().
 */
export interface GoogleSpreadsheetMetadataResponse {
    spreadsheetId: string;
    title?: string;
    spreadsheetUrl?: string;
    owners?: GoogleDriveOwner[];
    modifiedTime?: string;
    createdTime?: string;
    sheets?: Array<{
        sheetId?: number;
        title?: string;
        index?: number;
        rowCount?: number;
        columnCount?: number;
        hidden?: boolean;
    }>;
}


/**
 * Raw response from GET /sheets/v4/spreadsheets/{id}/values/{range}.
 * Returned by getSheetValues().
 *
 * `values` is a 2D array: values[rowIndex][colIndex] = cell string value.
 * Row 0 is typically the header row if the sheet follows that convention.
 * Empty trailing cells in a row are omitted by the API.
 */
export interface GoogleSheetValuesApiResponse {
    range?: string;
    majorDimension?: string; // "ROWS" (default) or "COLUMNS"
    values?: string[][];
}

/**
 * Raw response from GET /sheets/v4/spreadsheets/{id}/values:batchGet.
 * Returned by batchGetValues().
 *
 * Each item in valueRanges corresponds to one requested range.
 */
export interface GoogleSheetBatchValuesApiResponse {
    spreadsheetId?: string;
    valueRanges?: GoogleSheetValuesApiResponse[];
}
