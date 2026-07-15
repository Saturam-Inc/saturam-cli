// ---------------------------------------------------------------------------
// Raw Confluence REST API response shapes
// ---------------------------------------------------------------------------

export interface ConfluenceUser {
    displayName?: string;
    accountId?: string;
    email?: string;
}

export interface ConfluenceLabel {
    name: string;
}

export interface ConfluenceVersion {
    number?: number;
    when?: string;
    by?: ConfluenceUser;
    message?: string;
}

export interface ConfluenceSpace {
    id?: number;
    key?: string;
    name?: string;
    type?: string;
    _links?: {
        webui?: string;
    };
}

export interface ConfluenceAncestor {
    id?: string;
    title?: string;
}

/**
 * Raw page body containers. `storage` is the canonical Confluence Storage Format
 * (XHTML-like). Pass `storage.value` to HtmlNormalizerService for Markdown conversion.
 */
export interface ConfluencePageBody {
    storage?: { value?: string; representation?: string };
    export_view?: { value?: string; representation?: string };
}

/**
 * Full raw Confluence page API response.
 * Returned by getPage() — body.storage.value contains the raw XHTML.
 */
export interface ConfluencePageApiResponse {
    id?: string;
    title?: string;
    type?: string;
    status?: string;
    body?: ConfluencePageBody;
    version?: ConfluenceVersion;
    space?: ConfluenceSpace;
    ancestors?: ConfluenceAncestor[];
    history?: {
        createdBy?: ConfluenceUser;
        createdDate?: string;
        lastUpdated?: ConfluenceVersion;
    };
    metadata?: {
        labels?: {
            results?: ConfluenceLabel[];
        };
    };
    children?: {
        page?: ConfluenceChildPagesApiResponse;
    };
    _links?: {
        webui?: string;
        self?: string;
    };
}

/**
 * Child pages list response. Returned by getChildPages().
 */
export interface ConfluenceChildPagesApiResponse {
    results?: Array<{
        id?: string;
        title?: string;
        type?: string;
        status?: string;
        _links?: { webui?: string };
    }>;
    start?: number;
    limit?: number;
    size?: number;
}

/**
 * Space list API response. Returned by getSpaces().
 */
export interface ConfluenceSpaceListApiResponse {
    results?: ConfluenceSpace[];
    start?: number;
    limit?: number;
    size?: number;
    _links?: { next?: string };
}

/**
 * A single page/content item returned by /rest/api/content endpoints
 * (e.g. getPagesInSpace). Direct shape — no nesting.
 */
export interface ConfluenceContentResult {
    id?: string;
    title?: string;
    type?: string;
    status?: string;
    space?: ConfluenceSpace;
    version?: ConfluenceVersion;
    _links?: { webui?: string };
}

/**
 * Content list response. Returned by getPagesInSpace().
 * Uses the /rest/api/content endpoint — results are direct page objects.
 */
export interface ConfluenceContentListApiResponse {
    results?: ConfluenceContentResult[];
    start?: number;
    limit?: number;
    size?: number;
    _links?: { next?: string };
}

/**
 * A single search result item from /rest/api/search (CQL endpoint).
 * The actual page data is nested under `.content`; the surrounding envelope
 * provides excerpt, space, and last-modified metadata.
 *
 * NOTE: `space` is NOT returned at the top level by Confluence Cloud.
 * Extract the space key from `resultGlobalContainer.displayUrl`
 * e.g. "/spaces/SM" → space key is "SM".
 */
export interface ConfluenceSearchResultItem {
    /** Nested page/blogpost object */
    content?: ConfluenceContentResult & {
        /** Expandable links, e.g. _expandable.space = "/rest/api/space/SM" */
        _expandable?: Record<string, string>;
        _links?: { webui?: string; self?: string; tinyui?: string };
    };
    /** Page title (duplicates content.title) */
    title?: string;
    /** Plain-text excerpt from the page body */
    excerpt?: string;
    /** Browser URL to the result */
    url?: string;
    /** ISO-8601 last-modified timestamp */
    lastModified?: string;
    /** Human-readable relative time (e.g. "2 days ago") */
    friendlyLastModified?: string;
    /**
     * Container info — use this to derive the space:
     *   - `title` → space display name
     *   - `displayUrl` → "/spaces/<KEY>" → extract the space key
     */
    resultGlobalContainer?: {
        title?: string;
        displayUrl?: string;
    };
    breadcrumbs?: Array<{ label?: string; url?: string; separator?: string }>;
    entityType?: string;
    score?: number;
}

/**
 * CQL search response. Returned by searchContent().
 * Uses the /rest/api/search endpoint — results are wrapped in a search envelope.
 * Access page ID via `item.content.id`, space via `item.space.key`.
 */
export interface ConfluenceSearchApiResponse {
    results?: ConfluenceSearchResultItem[];
    start?: number;
    limit?: number;
    size?: number;
    totalSize?: number;
    _links?: { next?: string };
}
