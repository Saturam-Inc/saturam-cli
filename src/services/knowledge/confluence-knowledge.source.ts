import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfluenceService } from "../../integrations/confluence/services/confluence.service";
import { HtmlNormalizerService } from "../normalizers/html-normalizer.service";
import { KnowledgeDocument, KnowledgeSource } from "./knowledge-source.model";

const logger = getLogger("ConfluenceKnowledgeSource");

/**
 * Adapter that maps a raw Confluence page (via ConfluenceService) into a KnowledgeDocument.
 * This class owns the fetch → normalize → KnowledgeDocument mapping.
 *
 * Any feature that needs "a Confluence page as a KnowledgeDocument" (onboarding, indexing, ask)
 * should call this adapter.
 */
@Service()
export class ConfluenceKnowledgeSource implements KnowledgeSource {
    constructor(
        private readonly confluence: ConfluenceService,
        private readonly html: HtmlNormalizerService,
    ) { }

    public async fetch(
        id: string,
        options?: { baseUrl?: string },
    ): Promise<KnowledgeDocument> {
        const baseUrl = options?.baseUrl ?? "";

        if (!id) {
            throw new Error("Confluence page ID is missing or invalid.");
        }
        if (!baseUrl) {
            throw new Error(`No base URL configured for Confluence page: ${id}`);
        }

        logger.info(`Fetching Confluence page ${id} from ${baseUrl}...`);

        // 1. Fetch raw API response
        const data = await this.confluence.getPage(baseUrl, id);

        // 2. Extract plain metadata fields
        const title = data.title || `Page ${id}`;
        const spaceKey = data.space?.key || "";
        const version = data.version?.number ?? 1;
        const updatedAt = data.version?.when || data.history?.createdDate || "";
        const author =
            data.version?.by?.displayName ||
            data.history?.lastUpdated?.by?.displayName ||
            data.history?.createdBy?.displayName ||
            "Unknown";
        const labels = data.metadata?.labels?.results?.map((l) => l.name) || [];

        // 3. HTML (Confluence Storage Format) → Markdown via normalizer
        const rawHtml = data.body?.storage?.value || "";
        if (!rawHtml) {
            logger.warn(`Fetched Confluence page ${id} ("${title}") contains no content.`);
        }
        const contentMarkdown = (() => {
            try {
                return rawHtml ? this.html.convertHtmlToMarkdown(rawHtml) : "_No Content_";
            } catch (err) {
                logger.error(`Failed to normalize HTML for Confluence page ${id} ("${title}"): ${(err as Error).message}`);
                return "_Normalization Failed — see logs for details_";
            }
        })();

        // 4. Build final Markdown content
        const baseOrigin = new URL(baseUrl).origin;
        const docUrl = `${baseOrigin}/wiki/spaces/${spaceKey}/pages/${id}`;

        const content =
            `# ${title}

| Field | Value |
| :--- | :--- |
| **Space** | ${spaceKey} |
| **Version** | ${version} |
| **Author** | ${author} |
| **Updated** | ${updatedAt} |
| **Labels** | ${labels.length > 0 ? labels.join(", ") : "_none_"} |
| **Link** | [Open in Confluence](${docUrl}) |

## Content
${contentMarkdown}
`.trim() + "\n";

        // 5. Return KnowledgeDocument
        return {
            id,
            source: "confluence",
            title,
            content,
            url: docUrl,
            metadata: {
                updatedAt,
                author,
                labels,
            },
        };
    }
}
