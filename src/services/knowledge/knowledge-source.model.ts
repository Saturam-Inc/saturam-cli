/**
 * Canonical domain type for a piece of knowledge fetched from any external source
 * (Jira, Confluence, Google Drive, etc.).
 * The adapters that produced these now live in the `on-boarding` Lambda; what remains here is the
 * shared vocabulary its output is described in — notably KnowledgeSourceType, whose values are the
 * folder names the pipeline writes under and the `source`/`category` metadata the CLI filters on.
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
 * Derived from the enum rather than written out again: a source added to the enum but missed in a
 * hand-written copy silently stops its documents being counted, and the project they belong to
 * disappears from the registry with nothing failing. The sync that writes these folders now runs
 * in Lambda, so this has to keep agreeing with the categories that pipeline produces.
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
    /** Raw spreadsheet rows (header row + data rows), set only for a spreadsheet source. */
    sheetRows?: string[][];
    /** The A1-notation range actually fetched, set only for a spreadsheet source. */
    sheetRange?: string;
}

/**
 * Each integration (Jira, Confluence, Google Drive) provides one implementation
 * that maps raw API JSON → KnowledgeDocument.
 */
export interface KnowledgeSource {
    fetch(id: string, options?: Record<string, unknown>): Promise<KnowledgeDocument>;
}
