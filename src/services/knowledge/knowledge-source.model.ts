/**
 * Canonical domain type for a piece of knowledge fetched from any external source
 * (Jira, Confluence, Google Drive, Bitbucket, etc.).
 * The adapters that produced these now live in the `onboarding-gsheet-lamba` Lambda; what remains here is the
 * shared vocabulary its output is described in — notably KnowledgeSourceType, whose values are the
 * folder names the pipeline writes under and the `source`/`category` metadata the CLI filters on.
 */

/** Strongly-typed discriminator for the integration that produced a KnowledgeDocument. */
export enum KnowledgeSourceType {
    CONFLUENCE = "confluence",
    JIRA = "jira",
    GOOGLE_DOCS = "google-docs",
    GOOGLE_SHEETS = "google-sheets",
    /** Source code read from a repository. Documents live under `<project>/bitbucket/<repo>/<path>.md`. */
    BITBUCKET = "bitbucket",
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

/**
 * The one category that holds source code rather than writing about it. Everything else in the
 * corpus is prose — a wiki page, a ticket, a document — and "docs" below means exactly that set.
 */
export const CODE_CATEGORY: string = KnowledgeSourceType.BITBUCKET;

/** The pipeline's own summary document of a repository, written beside its files (`_repository.md`). */
export const REPOSITORY_INDEX_DOCUMENT = "_repository";

/** True for the pipeline's repository index document; a file that merely starts with `_` (`__init__.py`) is not it. */
export function isRepositoryIndexDocument(path: string): boolean {
    return path.replace(/\.md$/, "") === REPOSITORY_INDEX_DOCUMENT;
}

/**
 * What a search is asked to cover. The corpus holds two kinds of material that answer different
 * questions — what a page explains, and what the code does — and a question is often clearly
 * about one of them. "all" is the default and is what the corpus looked like before code was
 * indexed: one search over everything.
 */
export type DocumentKind = "docs" | "code" | "all";

export const DOCUMENT_KINDS: readonly DocumentKind[] = ["docs", "code", "all"];

export function isDocumentKind(value: unknown): value is DocumentKind {
    return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * The metadata filters a retrieval carries. Each field is an exact match against the attribute of
 * the same name in the document's sidecar, and the set is ANDed. Kept flat so the plain
 * `{ project }` call the inspector has always made keeps working unchanged.
 */
export interface RetrievalFilters {
    /** Project slug, as the registry lists it. */
    project?: string;
    /** Source category — `bitbucket` for code, or one of the document categories. */
    category?: string;
    /** Every category except this one. How a search is narrowed to prose. */
    excludeCategory?: string;
    /** `workspace/repo-slug`, as the code documents' `repo` attribute carries it. */
    repo?: string;
}

/**
 * Turns the way a caller thinks about scope — project, kind, repository — into the filters the
 * knowledge base understands. A repository filter implies code: nothing else carries a `repo`
 * attribute, so asking for prose from one repository would only ever return nothing.
 */
export function retrievalFiltersFor(scope: { project?: string; kind?: DocumentKind; repo?: string }): RetrievalFilters {
    const filters: RetrievalFilters = {};
    if (scope.project) filters.project = scope.project;
    if (scope.repo) {
        filters.repo = scope.repo;
        filters.category = CODE_CATEGORY;
    } else if (scope.kind === "code") {
        filters.category = CODE_CATEGORY;
    } else if (scope.kind === "docs") {
        filters.excludeCategory = CODE_CATEGORY;
    }
    return filters;
}

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
