import { mkdir, writeFile } from "fs/promises";
import { getLogger } from "log4js";
import { dirname, join, resolve } from "path";
import pLimit from "p-limit";
import { Service } from "typedi";
import { z } from "zod";
import { ConfluenceService } from "../../integrations/confluence/services/confluence.service";
import { JiraService } from "../../integrations/jira/services/jira.service";
import { GoogleDriveService } from "../../integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../config-service";
import { JiraKnowledgeSource } from "../knowledge/jira-knowledge.source";
import { ConfluenceKnowledgeSource } from "../knowledge/confluence-knowledge.source";
import { GoogleDriveKnowledgeSource } from "../knowledge/google-drive-knowledge.source";
import { KnowledgeDocument } from "../knowledge/knowledge-source.model";

const logger = getLogger("OnboardService");

// --- Config Schemas ---

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

// --- Internal mapped task types (after URL parsing) ---

interface MappedConfluenceTask {
    id: string;
    baseUrl?: string;
    projectName?: string;
    outputPath?: string;
}

interface MappedJiraTask {
    id: string;
    baseUrl?: string;
    projectName?: string;
    outputPath?: string;
}

interface MappedGoogleDocTask {
    id: string;
    projectName?: string;
    outputPath?: string;
}

@Service()
export class OnboardService {
    constructor(
        // Integration services — needed for Google Sheets (not covered by KnowledgeSource adapters)
        private readonly confluence: ConfluenceService,
        private readonly jira: JiraService,
        private readonly googleDrive: GoogleDriveService,
        private readonly config: ConfigService,
        // KnowledgeSource adapters — own the fetch → normalize → KnowledgeDocument mapping
        private readonly jiraSource: JiraKnowledgeSource,
        private readonly confluenceSource: ConfluenceKnowledgeSource,
        private readonly googleDriveSource: GoogleDriveKnowledgeSource,
    ) { }

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
                    const pages = await this.confluence.listAllPagesInSpace(targetBaseUrl, spaceKey);
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
                        const pages = await this.confluence.listAllPagesInSpace(baseUrl, confProj.space);
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
                        const ticketKeys = await this.jira.listAllIssuesByJql(baseUrl, jiraProj.jql);
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

    // --- Confluence orchestration (thin: delegate to adapter → writeDoc) ---

    private async executeConfluenceTasks(
        tasks: MappedConfluenceTask[],
        cwd: string,
        defaultBaseUrl?: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} Confluence page(s) to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();
        const limit = pLimit(5);
        const usedPaths = new Set<string>();

        const results = await Promise.allSettled(
            tasks.map((task) =>
                limit(async () => {
                    const { id, outputPath, projectName, baseUrl } = task;
                    const targetBaseUrl = baseUrl || defaultBaseUrl || "";

                    // Delegate fetch + normalize to the adapter
                    const doc = await this.confluenceSource.fetch(id, { baseUrl: targetBaseUrl });

                    // Determine output path
                    const safeTitle = this.getSafeTitle(doc.title, id);
                    const sanitizedProj = this.sanitizeProjectName(projectName);
                    const candidatePath = outputPath
                        ? resolve(cwd, outputPath)
                        : sanitizedProj
                            ? join(baseOnboardDir, "confluence", sanitizedProj, `${safeTitle}.md`)
                            : join(baseOnboardDir, "confluence", `${safeTitle}.md`);

                    const absoluteOutputPath = this.getUniqueOutputPath(candidatePath, usedPaths);
                    usedPaths.add(absoluteOutputPath);

                    await this.writeDoc(doc, absoluteOutputPath);
                    logger.info(`✓ Saved Confluence page "${doc.title}" to: ${absoluteOutputPath} (and JSON metadata)`);
                })
            )
        );

        this.logResults(results, "Confluence", "page(s)");
    }

    // --- Jira orchestration (thin: delegate to adapter → writeDoc) ---

    private async executeJiraTasks(
        tasks: MappedJiraTask[],
        cwd: string,
        defaultBaseUrl?: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} Jira ticket(s) to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();
        const limit = pLimit(5);
        const usedPaths = new Set<string>();

        const results = await Promise.allSettled(
            tasks.map((task) =>
                limit(async () => {
                    const { id, outputPath, projectName, baseUrl } = task;
                    const targetBaseUrl = baseUrl || defaultBaseUrl || "";

                    // Delegate fetch + normalize to the adapter
                    const doc = await this.jiraSource.fetch(id, { baseUrl: targetBaseUrl });

                    // Determine output path
                    const safeTitle = this.getSafeTitle(doc.title, id);
                    const sanitizedProj = this.sanitizeProjectName(projectName);
                    const candidatePath = outputPath
                        ? resolve(cwd, outputPath)
                        : sanitizedProj
                            ? join(baseOnboardDir, "jira", sanitizedProj, `${safeTitle}.md`)
                            : join(baseOnboardDir, "jira", `${safeTitle}.md`);

                    // Deduplicate colliding output paths
                    const absoluteOutputPath = this.getUniqueOutputPath(candidatePath, usedPaths);
                    usedPaths.add(absoluteOutputPath);

                    await this.writeDoc(doc, absoluteOutputPath);
                    logger.info(`✓ Saved Jira ticket "${doc.title}" to: ${absoluteOutputPath} (and JSON metadata)`);
                })
            )
        );

        this.logResults(results, "Jira", "ticket(s)");
    }

    // --- Google Docs orchestration (thin: delegate to adapter → writeDoc) ---

    private async executeGoogleDocsTasks(
        tasks: MappedGoogleDocTask[],
        cwd: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} Google Document(s) to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();
        const limit = pLimit(5);
        const usedPaths = new Set<string>();

        const results = await Promise.allSettled(
            tasks.map((task) =>
                limit(async () => {
                    const { id, outputPath, projectName } = task;

                    // Delegate fetch + normalize to the adapter
                    const doc = await this.googleDriveSource.fetch(id);

                    // Determine output path
                    const safeTitle = this.getSafeTitle(doc.title, id);
                    const sanitizedProj = this.sanitizeProjectName(projectName);
                    const candidatePath = outputPath
                        ? resolve(cwd, outputPath)
                        : sanitizedProj
                            ? join(baseOnboardDir, "google-docs", sanitizedProj, `${safeTitle}.md`)
                            : join(baseOnboardDir, "google-docs", `${safeTitle}.md`);

                    // Deduplicate colliding output paths
                    const absoluteOutputPath = this.getUniqueOutputPath(candidatePath, usedPaths);
                    usedPaths.add(absoluteOutputPath);

                    await this.writeDoc(doc, absoluteOutputPath);
                    logger.info(`✓ Saved Google Document "${doc.title}" to: ${absoluteOutputPath}`);
                })
            )
        );

        this.logResults(results, "Google Docs", "document(s)");
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

    // --- Shared persistence helper ---

    /**
     * Writes a KnowledgeDocument to disk:
     *   - <absoluteOutputPath>       — Markdown content
     *   - <absoluteOutputPath>.json  — JSON metadata sidecar (no content field)
     */
    private async writeDoc(doc: KnowledgeDocument, absoluteOutputPath: string): Promise<void> {
        const absoluteJsonPath = absoluteOutputPath.replace(/\.md$/, ".json");
        const { content: _content, ...metadataOnly } = doc;

        await mkdir(dirname(absoluteOutputPath), { recursive: true });
        await writeFile(absoluteOutputPath, doc.content, "utf8");
        await writeFile(absoluteJsonPath, JSON.stringify(metadataOnly, null, 4), "utf8");
    }

    // --- Logging helper ---

    private logResults(
        results: PromiseSettledResult<void>[],
        label: string,
        unit: string,
    ): void {
        results.forEach((res) => {
            if (res.status === "rejected") {
                logger.error(`✗ ${label} sync task failed: ${res.reason.message}`);
            }
        });
        const fetchedCount = results.filter((r) => r.status === "fulfilled").length;
        const failedCount = results.filter((r) => r.status === "rejected").length;
        logger.info(`\n${label} sync completed: ${fetchedCount} ${unit} fetched, ${failedCount} failed.`);
    }

    // --- Private utilities ---

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

    private getUniqueOutputPath(basePath: string, usedPaths: Set<string>): string {
        const getUnique = (path: string, suffix: number): string => {
            if (!usedPaths.has(path)) return path;
            const nextPath = path.replace(/(-\d+)?\.md$/, `-${suffix}.md`);
            return getUnique(nextPath, suffix + 1);
        };
        return getUnique(basePath, 2);
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
