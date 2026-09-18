import { readdir, readFile } from "fs/promises";
import { getLogger } from "log4js";
import { dirname, join } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { S3Service } from "../../integrations/aws/services/s3.service";
import { ConfigService } from "../config-service";
import { slugify } from "../../utils/slug.util";

const logger = getLogger("ProjectRegistry");

/** Fixed key the ingestion pipeline writes, relative to the configured S3 prefix. */
export const REGISTRY_S3_KEY = "registry.json";

export const RegistryProjectSchema = z.object({
    slug: z.string(),
    displayName: z.string(),
    aliases: z.array(z.string()).default([]),
    documentCount: z.number().optional(),
    summary: z.string().optional(),
    sources: z.array(z.string()).default([]),
});

export const ProjectRegistrySchema = z.object({
    generatedAt: z.string().optional(),
    projects: z.array(RegistryProjectSchema),
});

export type RegistryProject = z.infer<typeof RegistryProjectSchema>;
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

/**
 * Knows which projects exist in the knowledge base.
 *
 * Automatic routing needs this and Bedrock cannot supply it: the Retrieve API filters on a
 * `project` metadata value but has no operation to enumerate the values present. So the registry
 * is read from S3 (written by the ingestion pipeline), and falls back to the locally synced
 * onboarding folders while that pipeline does not yet exist.
 *
 * Resolved once per process — the project list does not change mid-conversation, and every
 * question would otherwise pay an S3 round trip.
 */
@Service()
export class ProjectRegistryService {
    private cached: ProjectRegistry | undefined;

    constructor(
        private readonly s3: S3Service,
        private readonly config: ConfigService,
    ) {}

    public async load(): Promise<ProjectRegistry> {
        if (this.cached) return this.cached;

        this.cached = (await this.loadFromS3()) ?? (await this.loadFromLocalSync()) ?? { projects: [] };
        if (this.cached.projects.length === 0) {
            logger.debug("Project registry is empty — routing will fall back to unfiltered retrieval.");
        }
        return this.cached;
    }

    private async loadFromS3(): Promise<ProjectRegistry | undefined> {
        try {
            const body = await this.s3.getObject(REGISTRY_S3_KEY);
            const parsed = ProjectRegistrySchema.parse(JSON.parse(body.toString("utf8")));
            logger.debug(`Loaded ${parsed.projects.length} project(s) from the S3 registry.`);
            return parsed;
        } catch (err) {
            logger.debug(`No usable S3 project registry (${(err as Error).message}) — trying the local sync.`);
            return undefined;
        }
    }

    /**
     * Derives a registry from the locally synced onboarding directories. This is a stopgap for
     * the period before the ingestion pipeline writes registry.json: it has no aliases and no
     * summaries, so disambiguation prompts are thinner, but routing still works.
     */
    private async loadFromLocalSync(): Promise<ProjectRegistry | undefined> {
        const baseDir = join(dirname(this.config.getPersonalConfigPath()), "onboarding");
        const categoryNames = new Set(["confluence", "jira", "google-docs", "google-sheets"]);

        try {
            const entries = await readdir(baseDir, { withFileTypes: true });
            const projects: RegistryProject[] = [];

            for (const entry of entries) {
                if (!entry.isDirectory() || categoryNames.has(entry.name)) continue;
                const documentCount = await this.countDocuments(join(baseDir, entry.name), categoryNames);
                if (documentCount === 0) continue;
                projects.push({
                    slug: entry.name,
                    displayName: entry.name,
                    aliases: [],
                    documentCount,
                    sources: [],
                });
            }

            if (projects.length === 0) return undefined;
            logger.debug(`Derived ${projects.length} project(s) from locally synced documents.`);
            return { projects };
        } catch {
            return undefined;
        }
    }

    private async countDocuments(projectDir: string, categoryNames: Set<string>): Promise<number> {
        let total = 0;
        for (const category of categoryNames) {
            try {
                const files = await readdir(join(projectDir, category));
                total += files.filter((f) => f.endsWith(".md")).length;
            } catch {
                // Category not present for this project.
            }
        }
        return total;
    }

    /**
     * Matches free text against a project's slug, display name, or aliases. Comparison is
     * slug-based so "Saturam Core", "saturam-core" and "saturam core" all match the same project.
     */
    public async findByName(name: string): Promise<RegistryProject[]> {
        const needle = slugify(name);
        if (!needle) return [];

        const { projects } = await this.load();
        return projects.filter((project) => {
            const candidates = [project.slug, project.displayName, ...project.aliases].map((c) => slugify(c));
            return candidates.some((candidate) => candidate === needle || candidate.includes(needle));
        });
    }

    public async getBySlug(slug: string): Promise<RegistryProject | undefined> {
        const { projects } = await this.load();
        return projects.find((project) => project.slug === slug);
    }

    /** One-line-per-project summary for prompts that must know what exists. */
    public async describeForPrompt(): Promise<string> {
        const { projects } = await this.load();
        if (projects.length === 0) return "(no projects are indexed yet)";

        return projects
            .map((project) => {
                const summary = project.summary ? ` — ${project.summary}` : "";
                const aliases = project.aliases.length > 0 ? ` (also called: ${project.aliases.join(", ")})` : "";
                return `- ${project.displayName} [slug: ${project.slug}]${aliases}${summary}`;
            })
            .join("\n");
    }
}
