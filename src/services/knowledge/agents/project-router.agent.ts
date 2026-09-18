import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { RetrievedChunk } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { PROJECT_ROUTER_SHAPE_HINT, getProjectRouterMessages } from "../../../prompts/project-router.prompt";
import { BedrockKnowledgeBaseService } from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { ProjectRegistryService, RegistryProject } from "../project-registry.service";
import { StructuredOutputService } from "../structured-output";

const logger = getLogger("ProjectRouter");

const TEMPERATURE = 0;

/** Chunks pulled for the unfiltered probe used to work out which projects are plausible. */
const PROBE_RESULT_COUNT = 10;

/**
 * A project "dominates" when it owns at least this share of the probe's chunks. Starting value,
 * to be tuned against the eval set rather than treated as settled.
 */
export const DOMINANCE_SHARE = 0.6;

/** Or when its best chunk outscores the runner-up's by at least this margin. */
export const DOMINANCE_SCORE_MARGIN = 0.15;

export const RouterCandidatesSchema = z.object({
    candidates: z
        .array(z.object({ slug: z.string(), confidence: z.number().default(0.5), why: z.string().default("") }))
        .default([]),
    reasoning: z.string().default(""),
});

export interface ProjectCandidate {
    project: RegistryProject;
    matchCount: number;
    topScore: number;
}

export type RoutingDecision =
    | { kind: "resolved"; project: RegistryProject; probeChunks: RetrievedChunk[] }
    | { kind: "ambiguous"; candidates: ProjectCandidate[]; probeChunks: RetrievedChunk[] }
    | { kind: "none"; probeChunks: RetrievedChunk[] };

/**
 * Decides which project a question is about, without the user having to pass a flag.
 *
 * Resolution order is cheapest-first: an explicit name from the question, then the session's
 * sticky project, then a broad unfiltered retrieval. The broad probe is the part worth defending —
 * rather than asking a model to guess which project a question belongs to, it looks at which
 * `project` values actually come back from the corpus. That grounds routing in what is indexed,
 * and costs one extra retrieval only on the ambiguous path.
 */
@Service()
export class ProjectRouterAgent {
    constructor(
        private readonly registry: ProjectRegistryService,
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly structured: StructuredOutputService,
    ) {}

    public async route(params: {
        question: string;
        projectHints: string[];
        activeProject?: string;
    }): Promise<RoutingDecision> {
        const named = await this.resolveFromHints(params.projectHints);
        if (named.length === 1) {
            logger.debug(`Routed to "${named[0].slug}" by name.`);
            return { kind: "resolved", project: named[0], probeChunks: [] };
        }
        if (named.length > 1) {
            logger.debug(`Hints matched ${named.length} projects — asking the user.`);
            return {
                kind: "ambiguous",
                candidates: named.map((project) => ({ project, matchCount: 0, topScore: 0 })),
                probeChunks: [],
            };
        }

        // No name in the question: a sticky project from earlier in the conversation is the most
        // likely subject, and avoids re-asking on every follow-up.
        if (params.activeProject) {
            const sticky = await this.registry.getBySlug(params.activeProject);
            if (sticky) {
                logger.debug(`Routed to "${sticky.slug}" from the active session project.`);
                return { kind: "resolved", project: sticky, probeChunks: [] };
            }
        }

        return this.routeByProbe(params.question);
    }

    private async resolveFromHints(hints: string[]): Promise<RegistryProject[]> {
        const matched = new Map<string, RegistryProject>();
        for (const hint of hints) {
            for (const project of await this.registry.findByName(hint)) {
                matched.set(project.slug, project);
            }
        }
        return [...matched.values()];
    }

    /** Runs one unfiltered retrieval and groups the results by their `project` metadata. */
    private async routeByProbe(question: string): Promise<RoutingDecision> {
        const probeChunks = await this.knowledgeBase
            .retrieve(question, { numberOfResults: PROBE_RESULT_COUNT })
            .catch((err) => {
                logger.warn(`Broad retrieval probe failed: ${(err as Error).message}`);
                return [] as RetrievedChunk[];
            });

        if (probeChunks.length === 0) return { kind: "none", probeChunks };

        const candidates = await this.groupByProject(probeChunks);
        if (candidates.length === 0) return { kind: "none", probeChunks };
        if (candidates.length === 1) return { kind: "resolved", project: candidates[0].project, probeChunks };

        const [top, runnerUp] = candidates;
        const share = top.matchCount / probeChunks.length;
        const margin = top.topScore - runnerUp.topScore;
        if (share >= DOMINANCE_SHARE || margin >= DOMINANCE_SCORE_MARGIN) {
            logger.debug(
                `Routed to "${top.project.slug}" by probe (share ${share.toFixed(2)}, margin ${margin.toFixed(3)}).`,
            );
            return { kind: "resolved", project: top.project, probeChunks };
        }

        // Close call — let the model prune candidates the evidence does not actually support
        // before the user is asked, so the picker stays short.
        const narrowed = await this.narrowCandidates(question, candidates);
        if (narrowed.length === 1) return { kind: "resolved", project: narrowed[0].project, probeChunks };
        return { kind: "ambiguous", candidates: narrowed.length > 0 ? narrowed : candidates, probeChunks };
    }

    private async groupByProject(chunks: RetrievedChunk[]): Promise<ProjectCandidate[]> {
        const byProject = new Map<string, { matchCount: number; topScore: number }>();

        for (const chunk of chunks) {
            const slug = typeof chunk.metadata?.project === "string" ? chunk.metadata.project : undefined;
            if (!slug) continue;
            const existing = byProject.get(slug) ?? { matchCount: 0, topScore: 0 };
            byProject.set(slug, {
                matchCount: existing.matchCount + 1,
                topScore: Math.max(existing.topScore, chunk.score ?? 0),
            });
        }

        const candidates: ProjectCandidate[] = [];
        for (const [slug, stats] of byProject) {
            const project = (await this.registry.getBySlug(slug)) ?? {
                slug,
                displayName: slug,
                aliases: [],
                sources: [],
            };
            candidates.push({ project, ...stats });
        }

        return candidates.sort((a, b) => b.matchCount - a.matchCount || b.topScore - a.topScore);
    }

    private async narrowCandidates(question: string, candidates: ProjectCandidate[]): Promise<ProjectCandidate[]> {
        const evidence = candidates
            .map(
                (c) =>
                    `- ${c.project.displayName} [slug: ${c.project.slug}]: ${c.matchCount} matching chunk(s), best score ${c.topScore.toFixed(3)}`,
            )
            .join("\n");

        try {
            const result = await this.structured.invoke({
                schema: RouterCandidatesSchema,
                name: "narrow_projects",
                shapeHint: PROJECT_ROUTER_SHAPE_HINT,
                messages: getProjectRouterMessages({
                    question,
                    projectCatalogue: await this.registry.describeForPrompt(),
                    candidateEvidence: evidence,
                }),
                options: { temperature: TEMPERATURE },
            });

            const keep = new Set(result.candidates.map((c) => c.slug));
            return candidates.filter((c) => keep.has(c.project.slug));
        } catch (err) {
            logger.debug(`Candidate narrowing failed (${(err as Error).message}) — asking across all candidates.`);
            return candidates;
        }
    }
}
