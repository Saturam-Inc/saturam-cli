import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { ChatTurn } from "../chat-session.model";
import { ProjectRegistryService } from "../project-registry.service";

const logger = getLogger("KnowledgeTools");

/** Chunks returned per search. One number, because the agent decides how many searches to run. */
const SEARCH_RESULT_COUNT = 12;

/**
 * The tools the mentor agent can call.
 *
 * This is the whole extension surface. Everything the old flow expressed as an intent branch —
 * "which project is this about", "plan four searches", "is this a question about the corpus
 * itself", "what did we discuss" — is now the agent choosing which of these to call and with
 * what arguments. Adding a capability means adding a tool here, not a branch, a constant and a
 * prompt paragraph somewhere else.
 */
export const KNOWLEDGE_TOOL_DEFINITIONS = [
    {
        name: "search_documentation",
        description:
            "Search the indexed internal documentation and return the most relevant passages. " +
            "Call this before answering anything about our systems, and call it again with different " +
            "wording when the first results miss the subject. Omit `project` for a broad search across " +
            "everything (useful when you do not yet know which project the question belongs to, or when " +
            "the question spans several); pass it to narrow to one project once you do. Each result " +
            "carries its project, title and source, so a broad search is also how you find out which " +
            "project a question is about.",
        schema: z.object({
            query: z
                .string()
                .describe("What to look for, phrased the way a document would state it rather than as a question."),
            project: z
                .string()
                .optional()
                .describe("Project slug to restrict the search to. Omit to search across all projects."),
        }),
    },
    {
        name: "list_projects",
        description:
            "List the projects that are indexed, with their slugs, document counts and summaries. " +
            "Call this to answer what you can help with, to find the exact slug for a project the user " +
            "named, or to check whether a subject is covered at all before saying it is not.",
        schema: z.object({}),
    },
    {
        name: "recall_conversation",
        description:
            "Return the earlier turns of this conversation, including ones from previous sessions that " +
            "are no longer in your immediate context. Call this when the user asks what was discussed, " +
            "what they asked before, or to be reminded of something from earlier.",
        schema: z.object({}),
    },
] as const;

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/**
 * Runs the tools and keeps whatever they retrieved.
 *
 * One executor per question. The chunks accumulate across every search the agent ran, because
 * the callers downstream — the source list, the unsupported-identifier check, the follow-up
 * generator — all need the evidence the answer was actually built from, not just the last search.
 */
export class KnowledgeToolExecutor {
    private readonly seen = new Map<string, RetrievedChunk>();
    private searches = 0;

    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly history: ChatTurn[],
    ) {}

    /** Every chunk any search returned this turn, newest search last, de-duplicated. */
    public get chunks(): RetrievedChunk[] {
        return [...this.seen.values()];
    }

    public get searchCount(): number {
        return this.searches;
    }

    public async run(call: ToolCall): Promise<string> {
        switch (call.name) {
            case "search_documentation":
                return this.search(call.args);
            case "list_projects":
                return this.listProjects();
            case "recall_conversation":
                return this.recall();
            default:
                // Returned rather than thrown: a model that invents a tool name should be told so
                // and given another turn, not have the question fail.
                return `There is no tool called "${call.name}". Available tools: ${KNOWLEDGE_TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`;
        }
    }

    private async search(args: Record<string, unknown>): Promise<string> {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return "The `query` argument is required and must be a non-empty string.";
        const project = typeof args.project === "string" && args.project.trim() ? args.project.trim() : undefined;

        this.searches += 1;
        let results: RetrievedChunk[];
        try {
            results = await this.knowledgeBase.retrieve(query, {
                project,
                numberOfResults: SEARCH_RESULT_COUNT,
            });
        } catch (err) {
            // The agent is told what went wrong so it can decide — retry, search differently, or
            // tell the user the corpus is unreachable. That decision is not the executor's.
            logger.warn(`Retrieval failed for "${query}": ${(err as Error).message}`);
            return `The search failed: ${(err as Error).message}. The knowledge base may be unreachable.`;
        }

        if (results.length === 0) {
            return project
                ? `No passages matched "${query}" within project "${project}". Try different wording, or search without the project filter.`
                : `No passages matched "${query}" anywhere in the indexed documentation. Try different wording.`;
        }

        for (const chunk of results) {
            this.seen.set(this.keyOf(chunk), chunk);
        }

        logger.debug(`search_documentation("${query}"${project ? `, project=${project}` : ""}) → ${results.length}`);

        return results
            .map((chunk, index) => {
                const meta = chunk.metadata ?? {};
                const label = [meta.project, meta.title, meta.source]
                    .filter((value): value is string => typeof value === "string" && value.length > 0)
                    .join(" · ");
                return `[${index + 1}]${label ? ` ${label}` : ""}\n${chunk.content.trim()}`;
            })
            .join("\n\n---\n\n");
    }

    /**
     * Content, not location: a document arrives as several chunks under one S3 URI, so keying on
     * the URI alone would collapse a whole document into its first chunk.
     */
    private keyOf(chunk: RetrievedChunk): string {
        return `${chunk.location ?? ""}::${chunk.content.trim().slice(0, 200)}`;
    }

    private async listProjects(): Promise<string> {
        const { projects } = await this.registry.load();
        if (projects.length === 0) {
            return "No projects are indexed. Only general engineering questions can be answered right now.";
        }
        return projects
            .map((project) => {
                const count = project.documentCount !== undefined ? `, ${project.documentCount} document(s)` : "";
                const aliases = project.aliases.length > 0 ? `, also called: ${project.aliases.join(", ")}` : "";
                const summary = project.summary ? ` — ${project.summary}` : "";
                return `- ${project.displayName} [slug: ${project.slug}${count}${aliases}]${summary}`;
            })
            .join("\n");
    }

    private async recall(): Promise<string> {
        if (this.history.length === 0) {
            return "Nothing has been asked yet — this is the first question in this conversation.";
        }
        return this.history
            .map((turn) => {
                const project = turn.resolvedProject ? ` [${turn.resolvedProject}]` : "";
                return `- Asked: "${turn.question}"${project}\n  You answered: ${turn.answerGist}`;
            })
            .join("\n");
    }
}

/** Builds an executor bound to this question's conversation history. */
@Service()
export class KnowledgeToolFactory {
    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
    ) {}

    public create(history: ChatTurn[]): KnowledgeToolExecutor {
        return new KnowledgeToolExecutor(this.knowledgeBase, this.registry, history);
    }
}
