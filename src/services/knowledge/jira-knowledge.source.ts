import { getLogger } from "log4js";
import { Service } from "typedi";
import { JiraService } from "../../integrations/jira/services/jira.service";
import { JiraComment } from "../../integrations/jira/models/jira.model";
import { AdfNormalizerService } from "../normalizers/adf-normalizer.service";
import { KnowledgeDocument, KnowledgeSource } from "./knowledge-source.model";

const logger = getLogger("JiraKnowledgeSource");

/**
 * Adapter that maps a raw Jira issue (via JiraService) into a KnowledgeDocument.
 * This class owns the fetch → normalize → KnowledgeDocument mapping.
 *
 * Any feature that needs "a Jira issue as a KnowledgeDocument" (onboarding, indexing, ask)
 * should call this adapter.
 */
@Service()
export class JiraKnowledgeSource implements KnowledgeSource {
    constructor(
        private readonly jira: JiraService,
        private readonly adf: AdfNormalizerService,
    ) { }

    public async fetch(
        id: string,
        options?: { baseUrl?: string },
    ): Promise<KnowledgeDocument> {
        const baseUrl = options?.baseUrl ?? "";

        if (!id) {
            throw new Error("Jira ticket key is missing or invalid.");
        }
        if (!baseUrl) {
            throw new Error(`No base URL configured for Jira ticket: ${id}`);
        }

        logger.info(`Fetching Jira ticket ${id} from ${baseUrl}...`);

        // 1. Fetch raw API response
        const data = await this.jira.getIssue(baseUrl, id);
        const fields = data.fields;

        // 2. Extract plain metadata fields
        const summary = fields?.summary || "No Summary";
        const status = fields?.status?.name || "Unknown";
        const assignee = fields?.assignee?.displayName || "Unassigned";
        const reporter = fields?.reporter?.displayName || "Unassigned";
        const priority = fields?.priority?.name || "Medium";
        const issueType = fields?.issuetype?.name || "Task";
        const created = fields?.created || "";
        const updated = fields?.updated || "";
        const labels = fields?.labels || [];

        // 3. ADF → Markdown via normalizer
        const description = (() => {
            try {
                return fields?.description
                    ? this.adf.renderAdfNode(fields.description)
                    : "";
            } catch (err) {
                logger.error(`Failed to render description ADF for Jira ticket ${id}: ${(err as Error).message}`);
                return "_Normalization Failed — see logs for details_";
            }
        })();

        const rawComments: JiraComment[] = fields?.comment?.comments || [];
        const commentsMarkdown = rawComments.map((c) => {
            const author = c.author?.displayName || "User";
            const date = c.created ? new Date(c.created).toLocaleString() : "";
            const body = (() => {
                try {
                    return c.body ? this.adf.renderAdfNode(c.body) : "";
                } catch (err) {
                    logger.error(`Failed to render comment ADF for Jira ticket ${id}: ${(err as Error).message}`);
                    return "_Normalization Failed — see logs for details_";
                }
            })();
            return `**Comment by ${author}** (${date}):\n${body}\n`;
        });

        // 4. Build final Markdown content
        const docUrl = `${baseUrl.replace(/\/$/, "")}/browse/${id}`;
        const content =
            `
# [${id}] ${summary}

| Field | Value |
| :--- | :--- |
| **Type** | ${issueType} |
| **Status** | ${status} |
| **Priority** | ${priority} |
| **Assignee** | ${assignee} |
| **Reporter** | ${reporter} |
| **Created** | ${created} |
| **Updated** | ${updated} |
| **Link** | [Open in Jira](${docUrl}) |

## Description
${description || "_No Description_"}

${commentsMarkdown.length > 0 ? `## Comments\n\n${commentsMarkdown.join("\n")}` : ""}
`.trim() + "\n";

        // 5. Return KnowledgeDocument
        return {
            id,
            source: "jira",
            title: summary,
            content,
            url: docUrl,
            metadata: {
                updatedAt: updated,
                author: reporter !== "Unassigned" ? reporter : assignee,
                labels,
            },
        };
    }
}
