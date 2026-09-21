/**
 * Canonical domain type for a piece of knowledge fetched from any external source
 * (Jira, Confluence, Google Drive, etc.).
 * Used by KnowledgeSource adapters, OnboardService, and future indexing/ask features.
 */

/** Strongly-typed discriminator for the integration that produced a KnowledgeDocument. */
export enum KnowledgeSourceType {
    CONFLUENCE = "confluence",
    JIRA = "jira",
    GOOGLE_DOCS = "google-docs",
    GOOGLE_SHEETS = "google-sheets",
}

/**
 * Every source category, and therefore every folder name a synced document can live under.
 *
 * Derived from the enum rather than written out again, because it was written out again — twice,
 * in the sync service and in the project registry. A fourth source added to the enum but missed
 * in one of those copies silently stops its documents being counted, and the project they belong
 * to disappears from the registry with nothing failing.
 */
export const KNOWLEDGE_SOURCE_CATEGORIES: readonly string[] = Object.values(KnowledgeSourceType);

export interface KnowledgeDocument {
    id: string;
    source: KnowledgeSourceType;
    title: string;
    content: string;
    url: string;
    metadata: {
        updatedAt?: string;
        author?: string;
        labels?: string[];
    };
    /** Raw spreadsheet rows (header row + data rows), set only by GoogleSheetsKnowledgeSource. */
    sheetRows?: string[][];
    /** The A1-notation range actually fetched, set only by GoogleSheetsKnowledgeSource. */
    sheetRange?: string;
}

/**
 * Each integration (Jira, Confluence, Google Drive) provides one implementation
 * that maps raw API JSON → KnowledgeDocument.
 */
export interface KnowledgeSource {
    fetch(id: string, options?: Record<string, unknown>): Promise<KnowledgeDocument>;
}
