import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { CONFLUENCE_API_PATH } from "../constants/confluence.constant";
import { fetchWithTimeout } from "../../../utils/fetch-with-timeout";
import {
    ConfluenceChildPagesApiResponse,
    ConfluenceContentListApiResponse,
    ConfluencePageApiResponse,
    ConfluenceSearchApiResponse,
    ConfluenceSpaceListApiResponse,
} from "../models/confluence.model";

const logger = getLogger("ConfluenceService");

@Service()
export class ConfluenceService {
    constructor(private readonly config: ConfigService) { }

    // --- Private helpers ---

    /**
     * Resolves the full Confluence REST API base.
     * Handles the common Atlassian Cloud shape (*.atlassian.net → append /wiki).
     */
    private getApiBase(baseUrl: string): string {
        const base = baseUrl.trim().replace(/\/$/, "");
        const withWiki =
            base.includes(".atlassian.net") && !base.endsWith("/wiki") ? `${base}/wiki` : base;
        return withWiki + CONFLUENCE_API_PATH; // e.g. https://example.atlassian.net/wiki/rest/api
    }

    private async getHeaders(): Promise<Record<string, string>> {
        const credentials = await this.config.getConfluenceCredentials();
        if (credentials.email) {
            return {
                Accept: "application/json",
                Authorization: `Basic ${Buffer.from(
                    `${credentials.email}:${credentials.token}`,
                ).toString("base64")}`,
            };
        }
        return {
            Accept: "application/json",
            Authorization: `Bearer ${credentials.token}`,
        };
    }

    // --- Page operations ---

    /**
     * Fetch a single Confluence page by ID.
     * Returns the raw API response including `body.storage.value` (Confluence Storage Format).
     * Pass body to HtmlNormalizerService for Markdown conversion.
     */
    public async getPage(baseUrl: string, pageId: string): Promise<ConfluencePageApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const expand =
            "body.storage,version,space,ancestors,history.lastUpdated,history.createdBy,metadata.labels";
        const url = `${apiBase}/content/${pageId}?expand=${encodeURIComponent(expand)}`;

        logger.debug(`Fetching Confluence page ${pageId} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch Confluence page ${pageId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<ConfluencePageApiResponse>;
    }

    /**
     * Fetch metadata for a Confluence page (no body content).
     */
    public async getPageMetadata(baseUrl: string, pageId: string): Promise<ConfluencePageApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const expand = "version,space,ancestors,history.lastUpdated,history.createdBy,metadata.labels";
        const url = `${apiBase}/content/${pageId}?expand=${encodeURIComponent(expand)}`;

        logger.debug(`Fetching Confluence page metadata ${pageId} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch Confluence page metadata ${pageId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<ConfluencePageApiResponse>;
    }

    /**
     * Fetch direct child pages of a given parent page.
     */
    public async listChildPages(
        baseUrl: string,
        pageId: string,
        options?: { limit?: number; start?: number },
    ): Promise<ConfluenceChildPagesApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const limit = options?.limit ?? 50;
        const start = options?.start ?? 0;
        const url = `${apiBase}/content/${pageId}/child/page?limit=${limit}&start=${start}`;

        logger.debug(`Fetching child pages for Confluence page ${pageId} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch child pages for ${pageId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<ConfluenceChildPagesApiResponse>;
    }

    // --- Space operations ---

    /**
     * List all Confluence spaces accessible with the current credentials.
     */
    public async listSpaces(
        baseUrl: string,
        options?: { limit?: number; start?: number },
    ): Promise<ConfluenceSpaceListApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const limit = options?.limit ?? 50;
        const start = options?.start ?? 0;
        const url = `${apiBase}/space?limit=${limit}&start=${start}`;

        logger.debug(`Fetching Confluence spaces from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch Confluence spaces: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<ConfluenceSpaceListApiResponse>;
    }

    /**
     * List all pages within a specific Confluence space.
     */
    public async listPagesInSpace(
        baseUrl: string,
        spaceKey: string,
        options?: { limit?: number; start?: number },
    ): Promise<ConfluenceContentListApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const limit = options?.limit ?? 100;
        const start = options?.start ?? 0;
        const url = `${apiBase}/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&limit=${limit}&start=${start}`;

        logger.debug(`Fetching pages in Confluence space ${spaceKey} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch pages in space ${spaceKey}: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<ConfluenceContentListApiResponse>;
    }

    /**
     * Convenience helper — fetches ALL pages in a space by auto-paginating listPagesInSpace().
     */
    public async listAllPagesInSpace(baseUrl: string, spaceKey: string): Promise<ConfluencePageApiResponse[]> {
        const limit = 100;
        const MAX_ITERATIONS = 1000;

        const fetchPageBatch = async (
            start: number,
            iterations: number,
            accumulatedPages: ConfluencePageApiResponse[],
        ): Promise<ConfluencePageApiResponse[]> => {
            if (iterations >= MAX_ITERATIONS) {
                logger.error(`listAllPagesInSpace: exceeded MAX_ITERATIONS (${MAX_ITERATIONS}) for space "${spaceKey}". Partial results returned.`);
                return accumulatedPages;
            }

            const result = await this.listPagesInSpace(baseUrl, spaceKey, { start, limit });
            const results = result.results || [];
            if (results.length === 0) {
                return accumulatedPages;
            }

            const nextAccumulated = [...accumulatedPages, ...results];
            if (results.length < limit) {
                return nextAccumulated;
            }

            return fetchPageBatch(start + limit, iterations + 1, nextAccumulated);
        };

        return fetchPageBatch(0, 0, []);
    }

    /**
     * Search Confluence content using CQL (Confluence Query Language).
     * Supports space, label, date, type-based queries, e.g.:
     *   `space = "DEV" AND type = page AND label = "onboarding"`
     *
     * NOTE: The response shape differs from getPagesInSpace:
     *   - Page data is nested under `results[].content` (not directly on `results[]`)
     *   - Space is on `results[].space` (top-level on the envelope, not inside content)
     *   - Use `item.content.id`, `item.content.title`, `item.space.key`
     *   - `item.excerpt` contains a plain-text snippet of the page body
     *   - `item.lastModified` is an ISO-8601 timestamp
     */
    public async searchContent(
        baseUrl: string,
        cql: string,
        options?: { limit?: number; start?: number },
    ): Promise<ConfluenceSearchApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const limit = options?.limit ?? 50;
        const start = options?.start ?? 0;
        const url = `${apiBase}/search?cql=${encodeURIComponent(cql)}&limit=${limit}&start=${start}`;

        logger.debug(`Searching Confluence content via CQL: ${cql}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to run Confluence CQL search: ${response.status} ${response.statusText} - ${text}`,
            );
        }
        return response.json() as Promise<ConfluenceSearchApiResponse>;
    }
}
