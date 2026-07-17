import { mkdir, writeFile } from "fs/promises";
import { getLogger } from "log4js";
import { dirname, join, resolve } from "path";
import { Service } from "typedi";
import { z } from "zod";
import * as mammoth from "mammoth";
import { ConfluenceService } from "../../integrations/confluence/services/confluence.service";
import { ConfluencePageApiResponse } from "../../integrations/confluence/models/confluence.model";
import { JiraService } from "../../integrations/jira/services/jira.service";
import { JiraComment } from "../../integrations/jira/models/jira.model";
import { GoogleDriveService } from "../../integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../config-service";
import { AdfNormalizerService } from "./adf-normalizer.service";
import { HtmlNormalizerService } from "./html-normalizer.service";
import { KnowledgeDocument } from "./knowledge-source.model";

const logger = getLogger("OnboardService");

export const OnboardPageSchema = z.union([
    z.string(),
    z.object({
        id: z.string(),
        outputPath: z.string().optional(),
    }),
]);

export const OnboardTicketSchema = z.union([
    z.string(),
    z.object({
        key: z.string(),
        outputPath: z.string().optional(),
    }),
]);

export const OnboardDocSchema = z.union([
    z.string(),
    z.object({
        id: z.string(),
        outputPath: z.string().optional(),
    }),
]);

export const OnboardConfluenceProjectConfig = z.object({
    baseUrl: z.string().optional(),
    space: z.string().optional(),
    pages: z.array(OnboardPageSchema).optional(),
});

export const OnboardJiraProjectConfig = z.object({
    baseUrl: z.string().optional(),
    tickets: z.array(OnboardTicketSchema).optional(),
    jql: z.string().optional(),
});

export const OnboardGoogleSheetsConfig = z.object({
    spreadsheetId: z.string(),
    /** A1 notation range e.g. "Sheet1!A:E". Defaults to all data in the first sheet. */
    range: z.string().optional(),
});

export const OnboardProjectConfig = z.object({
    confluence: OnboardConfluenceProjectConfig.optional(),
    jira: OnboardJiraProjectConfig.optional(),
    googleDocs: z
        .object({
            docs: z.array(OnboardDocSchema).optional(),
        })
        .optional(),
    googleSheets: OnboardGoogleSheetsConfig.optional(),
});

export const OnboardConfigSchema = z.object({
    confluence: z
        .object({
            baseUrl: z.string().optional(),
            pages: z.array(OnboardPageSchema).optional(),
            spaces: z.array(z.string()).optional(),
        })
        .optional(),
    jira: z
        .object({
            baseUrl: z.string().optional(),
            tickets: z.array(OnboardTicketSchema).optional(),
        })
        .optional(),
    googleDocs: z
        .object({
            docs: z.array(OnboardDocSchema).optional(),
        })
        .optional(),
    googleSheets: OnboardGoogleSheetsConfig.optional(),
    projects: z.record(z.string(), OnboardProjectConfig).optional(),
});

export type OnboardConfig = z.infer<typeof OnboardConfigSchema>;

export interface ConfluenceTask {
    pageEntry: z.infer<typeof OnboardPageSchema>;
    projectName?: string;
    baseUrl?: string;
}

export interface JiraTask {
    ticketEntry: z.infer<typeof OnboardTicketSchema>;
    projectName?: string;
    baseUrl?: string;
}

export interface GoogleDocTask {
    docEntry: z.infer<typeof OnboardDocSchema>;
    projectName?: string;
}

@Service()
export class OnboardService {
    constructor(
        private readonly confluence: ConfluenceService,
        private readonly jira: JiraService,
        private readonly googleDrive: GoogleDriveService,
        private readonly config: ConfigService,
        private readonly adfNormalizer: AdfNormalizerService,
        private readonly htmlNormalizer: HtmlNormalizerService,
    ) {}

    public async sync(config: OnboardConfig, cwd: string): Promise<void> {
        // Collect Confluence tasks
        const globalConfluenceTasks =
            config.confluence?.pages?.map((pageEntry) => ({
                pageEntry,
                baseUrl: config.confluence?.baseUrl,
            })) || [];

        const globalSpacePages = await (config.confluence?.spaces || []).reduce(
            async (accPromise, spaceKey) => {
                const acc = await accPromise;
                const targetBaseUrl = config.confluence?.baseUrl;
                if (!targetBaseUrl) {
                    logger.error("No base URL configured for global confluence spaces.");
                    return acc;
                }
                try {
                    logger.info(`Resolving pages for global space: ${spaceKey}...`);
                    let start = 0;
                    const limit = 100;
                    const pages: ConfluencePageApiResponse[] = [];
                    while (true) {
                        const result = await this.confluence.listPagesInSpace(targetBaseUrl, spaceKey, { start, limit });
                        const results = result.results || [];
                        pages.push(...results);
                        if (results.length < limit) break;
                        start += limit;
                    }
                    const spaceTasks = pages.map((page) => ({
                        pageEntry: { id: page.id! },
                        projectName: spaceKey,
                        baseUrl: targetBaseUrl,
                    }));
                    return [...acc, ...spaceTasks];
                } catch (err) {
                    logger.error(`Failed to resolve global space ${spaceKey}: ${(err as Error).message}`);
                    return acc;
                }
            },
            Promise.resolve([] as ConfluenceTask[]),
        );

        const projectConfluenceTasks = await Object.entries(config.projects || {}).reduce(
            async (accPromise, [projectName, projectConfig]) => {
                const acc = await accPromise;
                if (!projectConfig.confluence) return acc;
                const confProj = projectConfig.confluence;
                const baseUrl = confProj.baseUrl || config.confluence?.baseUrl;

                const spaceTasks = await (async () => {
                    if (!confProj.space) return [];
                    if (!baseUrl) {
                        logger.error(`No base URL configured for Confluence space in project: ${projectName}`);
                        return [];
                    }
                    try {
                        logger.info(`Resolving pages for project ${projectName} from space ${confProj.space}...`);
                        let start = 0;
                        const limit = 100;
                        const pages: ConfluencePageApiResponse[] = [];
                        while (true) {
                            const result = await this.confluence.listPagesInSpace(baseUrl, confProj.space, { start, limit });
                            const results = result.results || [];
                            pages.push(...results);
                            if (results.length < limit) break;
                            start += limit;
                        }
                        return pages.map((page) => ({
                            pageEntry: { id: page.id! },
                            projectName,
                            baseUrl,
                        }));
                    } catch (err) {
                        logger.error(
                            `Failed to resolve space ${confProj.space} for project ${projectName}: ${(err as Error).message}`,
                        );
                        return [];
                    }
                })();

                const pageTasks =
                    confProj.pages?.map((pageEntry) => ({
                        pageEntry,
                        projectName,
                        baseUrl,
                    })) || [];

                return [...acc, ...spaceTasks, ...pageTasks];
            },
            Promise.resolve([] as ConfluenceTask[]),
        );

        const confluenceTasks: ConfluenceTask[] = [
            ...globalConfluenceTasks,
            ...globalSpacePages,
            ...projectConfluenceTasks,
        ];

        // Collect Jira Tasks
        const globalJiraTasks =
            config.jira?.tickets?.map((ticketEntry) => ({
                ticketEntry,
                baseUrl: config.jira?.baseUrl,
            })) || [];

        const projectJiraTasks = await Object.entries(config.projects || {}).reduce(
            async (accPromise, [projectName, projectConfig]) => {
                const acc = await accPromise;
                if (!projectConfig.jira) return acc;
                const jiraProj = projectConfig.jira;
                const baseUrl = jiraProj.baseUrl || config.jira?.baseUrl;

                const jqlTasks = await (async () => {
                    if (!jiraProj.jql) return [];
                    if (!baseUrl) {
                        logger.error(`No base URL configured for Jira JQL search in project: ${projectName}`);
                        return [];
                    }
                    try {
                        logger.info(`Resolving Jira tickets for project ${projectName} via JQL: ${jiraProj.jql}...`);
                        let startAt = 0;
                        const maxResults = 100;
                        const ticketKeys: string[] = [];
                        while (true) {
                            const result = await this.jira.searchIssues(baseUrl, jiraProj.jql, { startAt, maxResults });
                            const issues = result.issues || [];
                            ticketKeys.push(...issues.map(issue => issue.key));
                            if (startAt + issues.length >= (result.total ?? 0) || issues.length < maxResults) {
                                break;
                            }
                            startAt += maxResults;
                        }
                        return ticketKeys.map((key) => ({
                            ticketEntry: { key },
                            projectName,
                            baseUrl,
                        }));
                    } catch (err) {
                        logger.error(`Failed to run JQL for project ${projectName}: ${(err as Error).message}`);
                        return [];
                    }
                })();

                const ticketTasks =
                    jiraProj.tickets?.map((ticketEntry) => ({
                        ticketEntry,
                        projectName,
                        baseUrl,
                    })) || [];

                return [...acc, ...jqlTasks, ...ticketTasks];
            },
            Promise.resolve([] as JiraTask[]),
        );

        const jiraTasks: JiraTask[] = [...globalJiraTasks, ...projectJiraTasks];

        // Collect Google Tasks
        const globalGoogleTasks = config.googleDocs?.docs?.map((docEntry) => ({ docEntry })) || [];
        const projectGoogleTasks = Object.entries(config.projects || {}).flatMap(
            ([projectName, projectConfig]) =>
                projectConfig.googleDocs?.docs?.map((docEntry) => ({ docEntry, projectName })) || [],
        );
        const googleTasks: GoogleDocTask[] = [...globalGoogleTasks, ...projectGoogleTasks];

        // Run executions
        if (confluenceTasks.length > 0) {
            const mappedTasks = confluenceTasks.map((t) => {
                const urlParsed =
                    typeof t.pageEntry === "string" &&
                    (t.pageEntry.startsWith("http://") || t.pageEntry.startsWith("https://"))
                        ? this.parseConfluenceUrl(t.pageEntry)
                        : null;
                return {
                    id: urlParsed ? urlParsed.pageId : typeof t.pageEntry === "string" ? t.pageEntry : t.pageEntry.id,
                    baseUrl: urlParsed ? urlParsed.baseUrl : t.baseUrl,
                    projectName: t.projectName,
                    outputPath: typeof t.pageEntry === "string" ? undefined : t.pageEntry.outputPath,
                };
            });
            await this.executeConfluenceTasks(mappedTasks, cwd, config.confluence?.baseUrl);
        }

        if (jiraTasks.length > 0) {
            const mappedTasks = jiraTasks.map((t) => {
                const urlParsed =
                    typeof t.ticketEntry === "string" &&
                    (t.ticketEntry.startsWith("http://") || t.ticketEntry.startsWith("https://"))
                        ? this.parseJiraUrl(t.ticketEntry)
                        : null;
                return {
                    id: urlParsed
                        ? urlParsed.ticketKey
                        : typeof t.ticketEntry === "string"
                          ? t.ticketEntry
                          : t.ticketEntry.key,
                    baseUrl: urlParsed ? urlParsed.baseUrl : t.baseUrl,
                    projectName: t.projectName,
                    outputPath: typeof t.ticketEntry === "string" ? undefined : t.ticketEntry.outputPath,
                };
            });
            await this.executeJiraTasks(mappedTasks, cwd, config.jira?.baseUrl);
        }

        if (googleTasks.length > 0) {
            const mappedTasks = googleTasks.map((t) => {
                const urlParsed =
                    typeof t.docEntry === "string" &&
                    (t.docEntry.startsWith("http://") || t.docEntry.startsWith("https://"))
                        ? this.parseGoogleDocUrl(t.docEntry)
                        : null;
                return {
                    id: urlParsed ? urlParsed : typeof t.docEntry === "string" ? t.docEntry : t.docEntry.id,
                    projectName: t.projectName,
                    outputPath: typeof t.docEntry === "string" ? undefined : t.docEntry.outputPath,
                };
            });
            await this.executeGoogleDocsTasks(mappedTasks, cwd);
        }

        // Google Sheets — read project index sheet if configured
        const globalSheetConfig = config.googleSheets;
        if (globalSheetConfig) {
            await this.executeGoogleSheetsTasks(globalSheetConfig, cwd);
        }

        const projectSheets = Object.entries(config.projects || {}).filter(
            ([_, projectConfig]) => projectConfig.googleSheets
        );
        for (const [projectName, projectConfig] of projectSheets) {
            if (projectConfig.googleSheets) {
                await this.executeGoogleSheetsTasks(projectConfig.googleSheets, cwd, projectName);
            }
        }

        const sheetsCount = (globalSheetConfig ? 1 : 0) + projectSheets.length;

        if (confluenceTasks.length === 0 && jiraTasks.length === 0 && googleTasks.length === 0 && sheetsCount === 0) {
            logger.warn("No Confluence pages, Jira tickets, Google Documents, or Google Sheets configured to fetch.");
        }
    }

    // --- Confluence-specific task executor (uses raw API + HtmlNormalizer directly) ---

    private async executeConfluenceTasks(
        tasks: Array<{ id: string; outputPath?: string; projectName?: string; baseUrl?: string }>,
        cwd: string,
        defaultBaseUrl?: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} Confluence page(s) to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();

        const results = await Promise.allSettled(
            tasks.map(async (task) => {
                const { id, outputPath, projectName, baseUrl } = task;
                const targetBaseUrl = baseUrl || defaultBaseUrl || "";

                if (!id) {
                    throw new Error("Confluence page ID is missing or invalid.");
                }

                if (!targetBaseUrl) {
                    throw new Error(`No base URL configured for Confluence page: ${id}`);
                }

                logger.info(`Fetching Confluence page ${id} from ${targetBaseUrl}...`);

                // 1. Fetch raw API response from integration layer
                const data = await this.confluence.getPage(targetBaseUrl, id);

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

                // 3. HtmlNormalizer converts Confluence Storage Format → Markdown (orchestration layer's job)
                const rawHtml = data.body?.storage?.value || "";
                if (!rawHtml) {
                    logger.warn(`Fetched Confluence page ${id} ("${title}") contains no content.`);
                }
                const contentMarkdown = rawHtml
                    ? this.htmlNormalizer.convertHtmlToMarkdown(rawHtml)
                    : "_No Content_";

                // 4. Build final Markdown content
                const baseOrigin = new URL(targetBaseUrl).origin;
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

                // 5. Build KnowledgeDocument
                const doc: KnowledgeDocument = {
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

                // 6. Persist .md and .json side-car files
                const safeTitle = this.getSafeTitle(title, id);
                const sanitizedProj = this.sanitizeProjectName(projectName);

                const absoluteOutputPath = outputPath
                    ? resolve(cwd, outputPath)
                    : sanitizedProj
                      ? join(baseOnboardDir, "confluence", sanitizedProj, `${safeTitle}.md`)
                      : join(baseOnboardDir, "confluence", `${safeTitle}.md`);

                const absoluteJsonPath = absoluteOutputPath.replace(/\.md$/, ".json");
                const { content: _content, ...metadataOnly } = doc;

                await mkdir(dirname(absoluteOutputPath), { recursive: true });
                await writeFile(absoluteOutputPath, content, "utf8");
                await writeFile(absoluteJsonPath, JSON.stringify(metadataOnly, null, 4), "utf8");

                logger.info(`✓ Saved Confluence page "${title}" to: ${absoluteOutputPath} (and JSON metadata)`);
            })
        );

        results.forEach((res) => {
            if (res.status === "rejected") {
                logger.error(`✗ Confluence sync task failed: ${res.reason.message}`);
            }
        });

        const fetchedCount = results.filter((r) => r.status === "fulfilled").length;
        const failedCount = results.filter((r) => r.status === "rejected").length;

        logger.info(`\nConfluence sync completed: ${fetchedCount} page(s) fetched, ${failedCount} failed.`);
    }

    // --- Jira-specific task executor (uses raw API + normalizer directly) ---

    private async executeJiraTasks(
        tasks: Array<{ id: string; outputPath?: string; projectName?: string; baseUrl?: string }>,
        cwd: string,
        defaultBaseUrl?: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} Jira ticket(s) to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();

        const results = await Promise.allSettled(
            tasks.map(async (task) => {
                const { id, outputPath, projectName, baseUrl } = task;
                const targetBaseUrl = baseUrl || defaultBaseUrl || "";

                if (!id) {
                    throw new Error("Jira ticket key is missing or invalid.");
                }

                if (!targetBaseUrl) {
                    throw new Error(`No base URL configured for Jira ticket: ${id}`);
                }

                logger.info(`Fetching Jira ticket ${id} from ${targetBaseUrl}...`);

                // 1. Fetch raw API response from integration layer
                const data = await this.jira.getIssue(targetBaseUrl, id);
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

                // 3. Normalizer converts ADF → Markdown (orchestration layer's job)
                const description = fields?.description
                    ? this.adfNormalizer.renderAdfNode(fields.description)
                    : "";

                const rawComments: JiraComment[] = fields?.comment?.comments || [];
                const commentsMarkdown = rawComments.map((c) => {
                    const author = c.author?.displayName || "User";
                    const date = c.created ? new Date(c.created).toLocaleString() : "";
                    const body = c.body ? this.adfNormalizer.renderAdfNode(c.body) : "";
                    return `**Comment by ${author}** (${date}):\n${body}\n`;
                });

                // 4. Build final Markdown content
                const docUrl = `${targetBaseUrl.replace(/\/$/, "")}/browse/${id}`;
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

                // 5. Build KnowledgeDocument
                const doc: KnowledgeDocument = {
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

                // 6. Persist .md and .json side-car files
                const safeTitle = this.getSafeTitle(summary, id);
                const sanitizedProj = this.sanitizeProjectName(projectName);

                const absoluteOutputPath = outputPath
                    ? resolve(cwd, outputPath)
                    : sanitizedProj
                      ? join(baseOnboardDir, "jira", sanitizedProj, `${safeTitle}.md`)
                      : join(baseOnboardDir, "jira", `${safeTitle}.md`);

                const absoluteJsonPath = absoluteOutputPath.replace(/\.md$/, ".json");
                const { content: _content, ...metadataOnly } = doc;

                await mkdir(dirname(absoluteOutputPath), { recursive: true });
                await writeFile(absoluteOutputPath, content, "utf8");
                await writeFile(absoluteJsonPath, JSON.stringify(metadataOnly, null, 4), "utf8");

                logger.info(`✓ Saved Jira ticket "${summary}" to: ${absoluteOutputPath} (and JSON metadata)`);
            })
        );

        results.forEach((res) => {
            if (res.status === "rejected") {
                logger.error(`✗ Jira sync task failed: ${res.reason.message}`);
            }
        });

        const fetchedCount = results.filter((r) => r.status === "fulfilled").length;
        const failedCount = results.filter((r) => r.status === "rejected").length;

        logger.info(`\nJira sync completed: ${fetchedCount} ticket(s) fetched, ${failedCount} failed.`);
    }

    // --- Google Docs dedicated task executor ---

    private async executeGoogleDocsTasks(
        tasks: Array<{ id: string; outputPath?: string; projectName?: string }>,
        cwd: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} Google Document(s) to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();

        const NATIVE_DOC_MIME = "application/vnd.google-apps.document";

        const results = await Promise.allSettled(
            tasks.map(async (task) => {
                const { id, outputPath, projectName } = task;

                if (!id) {
                    throw new Error("Google Document ID is missing or invalid.");
                }

                logger.info(`Fetching Google Document ${id}...`);

                // 1. Fetch raw metadata to get title and mimeType
                const metadata = await this.googleDrive.getFileMetadata(id);
                const title = metadata.name ?? id;
                const mimeType = metadata.mimeType ?? "";

                // 2. Fetch content — route based on mimeType
                const markdownContent = await (async () => {
                    if (mimeType === NATIVE_DOC_MIME) {
                        // Native Google Doc: Drive exports Markdown directly — no conversion needed
                        return await this.googleDrive.exportGoogleDocAsMarkdown(id);
                    } else if (
                        mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
                        title.endsWith(".docx")
                    ) {
                        // Non-native Word docx: download raw binary, parse via mammoth, convert HTML to Markdown
                        logger.info(`Downloading binary Word document (${title}) and parsing locally...`);
                        const arrayBuffer = await this.googleDrive.getFileBinary(id);
                        const buffer = Buffer.from(arrayBuffer);
                        const result = await mammoth.convertToHtml({ buffer });
                        return this.htmlNormalizer.convertHtmlToMarkdown(result.value);
                    } else {
                        throw new Error(
                            `Unsupported file type: ${mimeType || "unknown"}. Only native Google Docs or Word .docx files are supported.`
                        );
                    }
                })();

                if (!markdownContent) {
                    logger.warn(`Fetched Google Document ${id} ("${title}") contains no content.`);
                }

                // 3. Build KnowledgeDocument and write files
                const safeTitle = this.getSafeTitle(title, id);
                const sanitizedProj = this.sanitizeProjectName(projectName);

                const absoluteOutputPath = outputPath
                    ? resolve(cwd, outputPath)
                    : sanitizedProj
                      ? join(baseOnboardDir, "google-docs", sanitizedProj, `${safeTitle}.md`)
                      : join(baseOnboardDir, "google-docs", `${safeTitle}.md`);

                const absoluteJsonPath = absoluteOutputPath.replace(/\.md$/, ".json");
                const metadataOnly: KnowledgeDocument = {
                    id,
                    source: "googleDocs",
                    title,
                    content: "",
                    url: `https://docs.google.com/document/d/${id}/edit`,
                    metadata: {
                        updatedAt: metadata.modifiedTime,
                        author: metadata.owners?.[0]?.displayName,
                        labels: [],
                    },
                };

                await mkdir(dirname(absoluteOutputPath), { recursive: true });
                await writeFile(absoluteOutputPath, markdownContent, "utf8");
                await writeFile(absoluteJsonPath, JSON.stringify({ ...metadataOnly, content: undefined }, null, 4), "utf8");

                logger.info(`✓ Saved Google Document "${title}" to: ${absoluteOutputPath}`);
            })
        );

        results.forEach((res) => {
            if (res.status === "rejected") {
                logger.error(`✗ Google Docs sync task failed: ${res.reason.message}`);
            }
        });

        const fetchedCount = results.filter((r) => r.status === "fulfilled").length;
        const failedCount = results.filter((r) => r.status === "rejected").length;

        logger.info(`\nGoogle Docs sync completed: ${fetchedCount} document(s) fetched, ${failedCount} failed.`);
    }

    // --- Google Sheets dedicated task executor ---

    private async executeGoogleSheetsTasks(
        sheetConfig: z.infer<typeof OnboardGoogleSheetsConfig>,
        cwd: string,
        projectName?: string,
    ): Promise<void> {
        const { spreadsheetId, range } = sheetConfig;
        if (projectName) {
            logger.info(`Reading Google Sheet ${spreadsheetId} for project "${projectName}"...`);
        } else {
            logger.info(`Reading project index sheet ${spreadsheetId}...`);
        }

        const baseOnboardDir = this.resolveBaseOnboardDir();

        try {
            // 1. Fetch spreadsheet metadata to get the title and available sheet tabs
            const spreadsheet = await this.googleDrive.getSpreadsheetMetadata(spreadsheetId);
            const spreadsheetTitle = spreadsheet.title ?? spreadsheetId;

            // 2. Determine range — default to first sheet all columns
            const firstSheetTitle = spreadsheet.sheets?.[0]?.title ?? "Sheet1";
            const effectiveRange = range ?? `${firstSheetTitle}`;

            // 3. Fetch cell values
            const batchData = await this.googleDrive.batchGetSpreadsheetValues(spreadsheetId, [effectiveRange]);
            const allRows = batchData.valueRanges?.[0]?.values ?? [];

            if (allRows.length === 0) {
                logger.warn(`Google Sheet "${spreadsheetTitle}" range "${effectiveRange}" returned no data.`);
                return;
            }

            // 4. Persist raw sheet as JSON sidecar for downstream tooling
            const safeTitle = this.getSafeTitle(spreadsheetTitle, spreadsheetId);
            const sanitizedProj = this.sanitizeProjectName(projectName);

            const outputDir = sanitizedProj
                ? join(baseOnboardDir, "google-sheets", sanitizedProj)
                : join(baseOnboardDir, "google-sheets");
            const jsonPath = join(outputDir, `${safeTitle}.json`);

            const sidecar = {
                spreadsheetId,
                title: spreadsheetTitle,
                range: effectiveRange,
                fetchedAt: new Date().toISOString(),
                rowCount: allRows.length,
                headers: allRows[0] ?? [],
                rows: allRows.slice(1),
            };

            await mkdir(outputDir, { recursive: true });
            await writeFile(jsonPath, JSON.stringify(sidecar, null, 4), "utf8");

            logger.info(`✓ Saved Google Sheet "${spreadsheetTitle}" index (${allRows.length - 1} data row(s)) to: ${jsonPath}`);
        } catch (err) {
            logger.error(`✗ Failed to read Google Sheet ${spreadsheetId}: ${(err as Error).message}`);
        }
    }

    private getSafeTitle(title: string, fallbackId: string): string {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "") || fallbackId;
    }

    private resolveBaseOnboardDir(): string {
        const personalPath = this.config.getPersonalConfigPath();
        return join(dirname(personalPath), "onboarding");
    }

    private sanitizeProjectName(projectName?: string): string | undefined {
        if (!projectName) return undefined;
        return projectName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "") || "default";
    }

    private parseConfluenceUrl(urlStr: string): { baseUrl: string; pageId: string } | null {
        try {
            const url = new URL(urlStr);
            const spacePageMatch = url.pathname.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/i);
            if (spacePageMatch) {
                return { baseUrl: url.origin, pageId: spacePageMatch[1] };
            }
            const pageIdQuery = url.searchParams.get("pageId");
            if (pageIdQuery) {
                return { baseUrl: url.origin, pageId: pageIdQuery };
            }
            const generalPageMatch = url.pathname.match(/\/pages\/(\d+)/i);
            if (generalPageMatch) {
                return { baseUrl: url.origin, pageId: generalPageMatch[1] };
            }
            return null;
        } catch {
            return null;
        }
    }

    private parseJiraUrl(urlStr: string): { baseUrl: string; ticketKey: string } | null {
        try {
            const url = new URL(urlStr);
            const browseMatch = url.pathname.match(/\/browse\/([A-Z0-9]+-\d+)/i);
            if (browseMatch) {
                return { baseUrl: url.origin, ticketKey: browseMatch[1].toUpperCase() };
            }
            const issuesMatch = url.pathname.match(/\/issues\/([A-Z0-9]+-\d+)/i);
            if (issuesMatch) {
                return { baseUrl: url.origin, ticketKey: issuesMatch[1].toUpperCase() };
            }
            return null;
        } catch {
            return null;
        }
    }

    private parseGoogleDocUrl(urlStr: string): string | null {
        try {
            const url = new URL(urlStr);
            if (!url.hostname.includes("docs.google.com")) return null;
            const match = url.pathname.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }
}
