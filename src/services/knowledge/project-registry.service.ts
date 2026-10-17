import { readdir, readFile } from "fs/promises";
import { getLogger } from "log4js";
import { dirname, join } from "path";
import { Service } from "typedi";
import { z } from "zod";
import { S3Service } from "../../integrations/aws/services/s3.service";
import { ConfigService } from "../config-service";
import { KNOWLEDGE_SOURCE_CATEGORIES } from "./knowledge-source.model";
import { slugify } from "../../utils/slug.util";

const logger = getLogger("ProjectRegistry");

/** Fixed key the ingestion pipeline writes, relative to the configured S3 *state* prefix. */
export const REGISTRY_S3_KEY = "registry.json";

/**
 * A repository the pipeline indexed for a project, as registry.json v2 lists it. Read off the
 * pipeline's per-repository state, so `folder` is the directory its documents live under
 * (`<project>/bitbucket/<folder>/`), which is what the browsing tools need to find them.
 */
export const RegistryRepoSchema = z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    folder: z.string(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    documentCount: z.number().optional(),
    indexedAt: z.string().optional(),
    /** False when the last run could not fetch every file; absent means complete. */
    complete: z.boolean().optional(),
});

export const RegistryProjectSchema = z.object({
    slug: z.string(),
    displayName: z.string(),
    aliases: z.array(z.string()).default([]),
    documentCount: z.number().optional(),
    summary: z.string().optional(),
    sources: z.array(z.string()).default([]),
    /** Documents per source category, so the listing can say how much of a project is code. */
    counts: z.record(z.string(), z.number()).optional(),
    /** Absent on a registry written before repositories were listed, and for a project without code. */
    repos: z.array(RegistryRepoSchema).optional(),
});

export const ProjectRegistrySchema = z.object({
    generatedAt: z.string().optional(),
    /** Absent on a registry written before repositories were listed; every field above is optional for that reason. */
    version: z.number().optional(),
    projects: z.array(RegistryProjectSchema),
});

export type RegistryRepo = z.infer<typeof RegistryRepoSchema>;
export type RegistryProject = z.infer<typeof RegistryProjectSchema>;
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

/** `workspace/repo-slug`, the form the code documents' `repo` attribute and Bitbucket both use. */
export function repoFullName(repo: Pick<RegistryRepo, "workspace" | "repoSlug">): string {
    return `${repo.workspace}/${repo.repoSlug}`;
}

/**
 * How long a loaded registry is trusted. A terminal run never gets near it; it exists for the
 * long-lived server process (the Slack bot's warm Lambda), which would otherwise keep answering
 * from whatever project list it saw at cold start while ingestion adds new ones.
 */
export const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Knows which projects exist in the knowledge base.
 *
 * Automatic routing needs this and Bedrock cannot supply it: the Retrieve API filters on a
 * `project` metadata value but has no operation to enumerate the values present. So the registry
 * is read from S3, where the ingestion pipeline writes it under the state prefix, and falls back
 * to the locally synced onboarding folders when no pipeline has run against this bucket.
 *
 * Cached for REGISTRY_CACHE_TTL_MS — the project list does not change mid-conversation, and every
 * question would otherwise pay an S3 round trip — but not forever, so a long-lived process still
 * sees projects the ingestion pipeline adds.
 */
@Service()
export class ProjectRegistryService {
    private cached: ProjectRegistry | undefined;
    private cachedAt = 0;

    constructor(
        private readonly s3: S3Service,
        private readonly config: ConfigService,
    ) {}

    public async load(now: number = Date.now()): Promise<ProjectRegistry> {
        if (this.cached && now - this.cachedAt < REGISTRY_CACHE_TTL_MS) return this.cached;

        this.cached = (await this.loadFromS3()) ?? (await this.loadFromLocalSync()) ?? { projects: [] };
        this.cachedAt = now;
        if (this.cached.projects.length === 0) {
            logger.debug("Project registry is empty — routing will fall back to unfiltered retrieval.");
        }
        return this.cached;
    }

    private async loadFromS3(): Promise<ProjectRegistry | undefined> {
        try {
            const body = await this.s3.getStateObject(REGISTRY_S3_KEY);
            const parsed = ProjectRegistrySchema.parse(JSON.parse(body.toString("utf8")));
            logger.debug(`Loaded ${parsed.projects.length} project(s) from the S3 registry.`);
            return parsed;
        } catch (err) {
            logger.debug(`No usable S3 project registry (${(err as Error).message}) — trying the local sync.`);
            return undefined;
        }
    }

    /**
     * Derives a registry from the locally synced onboarding directories, for a bucket no
     * ingestion pipeline has written a registry.json for yet. It has no aliases and no summaries,
     * so the agent's project listing is thinner, but project-scoped search still works.
     */
    private async loadFromLocalSync(): Promise<ProjectRegistry | undefined> {
        const baseDir = join(dirname(this.config.getPersonalConfigPath()), "onboarding");
        const categoryNames = new Set(KNOWLEDGE_SOURCE_CATEGORIES);

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

    /** The repositories indexed for a project; empty for a project without code or an older registry. */
    public async reposOf(slug: string): Promise<RegistryRepo[]> {
        return (await this.getBySlug(slug))?.repos ?? [];
    }

    /**
     * A real indexed project name for prompts to use in their examples.
     *
     * Prompt instructions illustrate shapes — "after a question about X, 'so what stacks are
     * used' becomes 'what stacks are used in X'" — and X has to be something. Baking a client's
     * name in at build time meant every other client's deployment carried that client's
     * vocabulary in its prompts. Drawing it from the registry means the example always names a
     * project that actually exists in this deployment, and reads as "the project" when nothing
     * is indexed yet.
     *
     * The first project is used rather than the session's current one: the classifier is what
     * decides the current project, and seeding its own example with that project is precisely
     * the "carry the earlier project forward" mistake its instructions warn against.
     */
    public async exampleProjectName(): Promise<string> {
        const { projects } = await this.load();
        return projects[0]?.displayName ?? "the project";
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
