import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { ChatTurn } from "../chat-session.model";
import { CodeIndexService, RepoIndex, SymbolMatch } from "../code-index.service";
import { DocumentReaderService, ReadRange } from "../document-reader.service";
import { CODE_CATEGORY, DOCUMENT_KINDS, isDocumentKind, retrievalFiltersFor } from "../knowledge-source.model";
import {
    GUIDE_DIRECTORY,
    GuideEntry,
    describeGuide,
    guidesIn,
    matchGuide,
    normalizeGuideTopic,
} from "../onboarding-guides";
import { ProjectRegistryService, RegistryProject, RegistryRepo, repoFullName } from "../project-registry.service";

const logger = getLogger("KnowledgeTools");

/** Chunks returned per search. One number, because the agent decides how many searches to run. */
const SEARCH_RESULT_COUNT = 12;

/**
 * Whole documents read per question. A plan that needs more than this has lost its way; a
 * question that needs one or two is the common case this exists for.
 */
export const MAX_READS_PER_QUESTION = 6;

/**
 * Onboarding guides opened per question, apart from the read budget. A guide is the thing we most
 * want read before an architecture answer or a change plan, so it must not compete with the code
 * reads that follow it; four is an overview, an architecture, an impact map and a recipe.
 */
export const MAX_GUIDES_PER_QUESTION = 4;

/**
 * The tools the mentor agent can call.
 *
 * This is the whole extension surface. Everything the old flow expressed as an intent branch —
 * "which project is this about", "plan four searches", "is this a question about the corpus
 * itself", "what did we discuss" — is now the agent choosing which of these to call and with
 * what arguments. Adding a capability means adding a tool here, not a branch, a constant and a
 * prompt paragraph somewhere else.
 *
 * The corpus holds two kinds of material since source code was indexed beside the documents:
 * prose that explains, and code that runs. Search covers both and can be narrowed to either;
 * reading and browsing exist because a search result is a slice, and a slice of code is rarely
 * enough to explain what the code does. The symbol tools exist because a change is planned
 * against definitions and their uses, which retrieval by similarity cannot enumerate.
 */
export const KNOWLEDGE_TOOL_DEFINITIONS = [
    {
        name: "search_documentation",
        description:
            "Search the indexed internal documentation and source code and return the most relevant passages. " +
            "Call this before answering anything about our systems, and call it again with different " +
            'wording when the first results miss the subject. `kind` chooses what to search: "docs" for ' +
            'written material (wiki pages, tickets, design documents), "code" for source files indexed from ' +
            'the repositories, "all" (the default) for both. Omit `project` for a broad search across ' +
            "everything (useful when you do not yet know which project the question belongs to, or when " +
            "the question spans several); pass it to narrow to one project once you do. `repo` narrows code " +
            "results to one repository, as workspace/repo-slug. Each result carries its project, title and " +
            "source, so a broad search is also how you find out which project a question is about, and a " +
            "`document:` id that read_document accepts.",
        schema: z.object({
            query: z
                .string()
                .describe("What to look for, phrased the way a document would state it rather than as a question."),
            project: z
                .string()
                .optional()
                .describe("Project slug to restrict the search to. Omit to search across all projects."),
            kind: z
                .enum(["docs", "code", "all"])
                .optional()
                .describe('"docs" for written documentation, "code" for source files, "all" (default) for both.'),
            repo: z
                .string()
                .optional()
                .describe('Restrict code results to one repository, as workspace/repo-slug. Implies kind "code".'),
        }),
    },
    {
        name: "read_document",
        description:
            "Read a whole document or source file from the corpus, when a search result is a slice of " +
            "something you need to see in full — the rest of a function, the sections around a passage, a " +
            "file a listing named. Pass the `document:` id a search result gave you, or `workspace/repo:path` " +
            "for a file a repository listing showed. A source file comes back with its own line numbers; use " +
            "startLine and endLine to read part of a long one, and call again when the reply says more remains. " +
            "There is a budget of a few reads per question, so read what you will actually use.",
        schema: z.object({
            document: z
                .string()
                .describe("The `document:` id from a search result, or workspace/repo:path from a repository listing."),
            startLine: z.number().int().positive().optional().describe("First line to return (1-based)."),
            endLine: z.number().int().positive().optional().describe("Last line to return (inclusive)."),
        }),
    },
    {
        name: "open_guide",
        description:
            "Open one of a project's onboarding guides by name, whole. A project documented to our standard " +
            "keeps numbered guides under docs/onboarding/: overview, tech-stack, repository-map, architecture, " +
            "running-locally, backend, frontend, data-model, data-lineage, transformations, metrics, pipelines, " +
            "data-quality, testing, integrations, configuration, deployment, operations, known-issues, glossary, " +
            "open-questions, making-changes, dependencies, change-impact-map, security-and-access, infrastructure, " +
            "interfaces-and-events, models, conventions, decisions, and 22-<topic> deep dives. Opening a guide by " +
            "name is more reliable than searching for it. Omit `topic` to list the guides the project has. An " +
            "architecture walkthrough starts from the architecture guide; a change plan from change-impact-map " +
            "and making-changes. Guides do not count against the read budget.",
        schema: z.object({
            project: z.string().describe("Project slug, as list_projects or a search result shows it."),
            topic: z
                .string()
                .optional()
                .describe(
                    "A guide's name (architecture, making-changes), its number (03, 25), or the subject of a " +
                        "22-deep dive. Omit to list the project's guides.",
                ),
        }),
    },
    {
        name: "browse_repository",
        description:
            "List what a project's source repositories contain, from the index. Call it with only the " +
            "project to see its repositories; then with `repo` and a `directory` to see one directory's " +
            "files and sub-directories. Use it when a question asks where something lives, what a module " +
            "is made of, or names a directory. Every path it returns is real and can be read with " +
            "read_document as workspace/repo:path.",
        schema: z.object({
            project: z.string().describe("Project slug, as list_projects or a search result shows it."),
            repo: z
                .string()
                .optional()
                .describe(
                    "Which repository, as workspace/repo-slug or just the slug. Omit to list the project's repositories.",
                ),
            directory: z
                .string()
                .optional()
                .describe('Directory to list, relative to the repository root, such as "src/jobs". Omit for the root.'),
        }),
    },
    {
        name: "find_symbol",
        description:
            "Look up where a function, class, method, constant, table or resource is defined in the indexed " +
            "source code, by name. Returns each definition's repository, path, line range, signature and " +
            "docstring. Use it when a search result mentions a name and you need its definition, when the " +
            "user names a function or class, or when planning a change to something specific. `Class.method` " +
            "finds a method of that class. Pass `project` to narrow to one project and `repo` to one repository.",
        schema: z.object({
            name: z.string().describe("The name as written in code, such as build_report or Scheduler.run."),
            project: z.string().optional().describe("Project slug to search within. Omit for every indexed project."),
            repo: z.string().optional().describe("Repository, as workspace/repo-slug or its slug."),
        }),
    },
    {
        name: "find_references",
        description:
            "Find every indexed file that uses a name — calls it, imports it or refers to it — along with its " +
            "definitions and the files that import a module of that name. The first thing to run when " +
            "planning a change to something: it shows what the change touches. Returns files with line " +
            "numbers; read the ones that matter with read_document. Exact name only.",
        schema: z.object({
            name: z
                .string()
                .describe("The name as written in code: a function, class, constant, table or module name."),
            project: z.string().optional().describe("Project slug to search within. Omit for every indexed project."),
            repo: z.string().optional().describe("Repository, as workspace/repo-slug or its slug."),
        }),
    },
    {
        name: "begin_change_plan",
        description:
            "Call this first when the question asks how to change, add, move, remove or migrate something — " +
            "a schedule, a field, a job, a screen, an integration, a configuration — rather than how it works. " +
            "Pass the goal as you understand it and any constraints the user gave. It records the goal for " +
            "the conversation, gives you room for the extra searches and reads a plan needs, and returns the " +
            "checklist to work through before you write the plan.",
        schema: z.object({
            goal: z.string().describe("The change, in one sentence, as the user would state it."),
            constraints: z
                .string()
                .optional()
                .describe("Anything the user said must hold: a deadline, what must not change, who must approve."),
        }),
    },
    {
        name: "begin_walkthrough",
        description:
            "Call this first when the question asks how something works end to end, how a system or component " +
            "is put together, how data or a request moves through it, or for an architecture overview — anything " +
            "whose answer is an explanation of a mechanism with several parts, rather than a single fact or a " +
            "change. Pass the subject as you understand it and what they asked you to focus on. It records the " +
            "subject, gives you room for the searches and reads an end-to-end explanation needs, and returns the " +
            "method to work through before you write.",
        schema: z.object({
            subject: z.string().describe("What is being explained, in one sentence, as the user would state it."),
            focus: z
                .string()
                .optional()
                .describe("The angle they asked for: the data path, the triggers, the failure modes, the design."),
        }),
    },
    {
        name: "list_projects",
        description:
            "List the projects that are indexed, with their slugs, document counts, repositories and summaries. " +
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
    {
        name: "note_findings",
        description:
            "Write down, for yourself, what you have established so far, what is still missing, and what you " +
            "will do next. Call it after a round of results whenever the question needs more than one search: " +
            "before choosing the next tool, and before writing a long answer or a plan. Nothing here reaches the " +
            "user. It keeps an investigation of several rounds from drifting, and the answer is written from " +
            "these notes rather than from memory of the results.",
        schema: z.object({
            established: z.string().describe("What you now know, each point with the file or document it came from."),
            missing: z.string().optional().describe("What the question still needs that you have not found."),
            next: z.string().optional().describe("The tool call or the decision you will make next."),
        }),
    },
] as const;

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/** What begin_change_plan recorded: the goal of the change being planned, and what must hold. */
export interface ChangePlan {
    goal: string;
    constraints?: string;
}

/** What begin_walkthrough recorded: the mechanism being explained, and the angle asked for. */
export interface Walkthrough {
    subject: string;
    focus?: string;
}

/** One note_findings call: the agent's own working notes, kept for the forced answer and for replays. */
export interface Finding {
    established: string;
    missing?: string;
    next?: string;
}

/**
 * The checklist begin_change_plan hands back. It is returned as a tool result rather than written
 * into the system prompt so it arrives at the moment the agent has decided a change is being
 * planned, as the next thing to read, instead of as one more paragraph among the general rules.
 */
export function changePlanChecklist(plan: ChangePlan): string {
    return [
        `Plan recorded: ${plan.goal}${plan.constraints ? ` Constraints: ${plan.constraints}` : ""}`,
        "You now have room for the extra searches and reads a plan needs. Work through this before you write:",
        "1. Locate — where the thing is defined, configured and consumed. Search the code with the exact identifiers, find_symbol for the definitions, find_references for every use, and read_document around the hits.",
        "2. Trace the impact — the tests that cover it, the documents that describe it, the jobs that run it, the data it produces, the configuration that points at it. Open the project's change-impact-map and making-changes guides first (open_guide) when it has them, and follow the recipe nearest to this change.",
        "3. Order the steps so each is verifiable on its own, naming the exact file, key or table for each.",
        "4. Say how to verify, what can go wrong, how to undo it, and who to involve, from the owners the documents name.",
        "5. List what you could not find as open questions, in your own voice, with who could answer each.",
        "Write the plan as numbered steps, with the impact list above them and verification below. Ask the user a question only when a missing constraint changes the plan; otherwise state your assumption and go on. Call note_findings after each round so nothing you located is lost by the time you write.",
    ].join("\n");
}

/**
 * The method begin_walkthrough hands back. An explanation of a mechanism has a natural order, the
 * order the data moves, and a model left to itself explains things in the order it found them.
 * Returned as a tool result for the same reason as the plan checklist: it arrives when the agent
 * has decided this is a walkthrough, as the next thing to read.
 */
export function walkthroughChecklist(walk: Walkthrough): string {
    return [
        `Walkthrough recorded: ${walk.subject}${walk.focus ? ` Focus: ${walk.focus}` : ""}`,
        "You now have room for the searches and reads an end-to-end explanation needs. Work through this before you write:",
        "1. Boundaries — what the subject is made of and where it starts and ends. Open the project's architecture and overview guides first (open_guide) when it has them; browse the repository for the modules involved.",
        "2. Entry points and triggers — what starts it: a schedule, a request, an event, a daemon, a user action. find_symbol for the entry function, then read it.",
        "3. The path — follow the data or the request from the entry point to where it ends, reading each hop you will describe. Name the file and the function or class at every hop. Where the documents and the code disagree, the code is what runs today.",
        "4. Where it runs and what it depends on — the configuration it reads, the tables and services it touches, the infrastructure it runs on (the pipelines, configuration, infrastructure and dependencies guides, when they exist).",
        "5. Design decisions and trade-offs — why it is built this way and what that gives up (the decisions guide when there is one; otherwise what the shape of the code implies, said as your reading of it).",
        "6. What tends to break, and how to tell it is healthy — the known-issues, operations and data-quality guides, and the tests that cover it.",
        "7. What you could not establish, as open questions in your own voice, with who could answer each.",
        "Call note_findings after each round so the path stays straight. Write in the order the data moves, not the order you found things; when three or more components talk, show the path as a short text diagram; say what is intent (documents) and what runs (code) only where the two differ.",
    ].join("\n");
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lineArg(args: Record<string, unknown>, name: string): number | undefined {
    const value = args[name];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function metadataString(chunk: RetrievedChunk, field: string): string | undefined {
    const value = chunk.metadata?.[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Runs the tools and keeps whatever they retrieved.
 *
 * One executor per question. The chunks accumulate across every search the agent ran, because
 * the callers downstream — the source list, the unsupported-identifier check, the follow-up
 * generator — all need the evidence the answer was actually built from, not just the last search.
 * So do the names: every path a listing returned and every document that was read is something
 * the agent genuinely saw, and the identifier guard must not take it back as an invention.
 */
export class KnowledgeToolExecutor {
    private readonly seen = new Map<string, RetrievedChunk>();
    private readonly known = new Set<string>();
    /** Text the agent was shown by a read or a lookup: what it quotes from there is as real as a passage. */
    private readonly shownText: string[] = [];
    private searches = 0;
    private reads = 0;
    private readonly readKeys = new Set<string>();
    private plan: ChangePlan | undefined;
    private walk: Walkthrough | undefined;
    private readonly notes: Finding[] = [];
    private guides = 0;

    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly reader: DocumentReaderService,
        private readonly codeIndex: CodeIndexService,
        private readonly history: ChatTurn[],
    ) {}

    /** Every chunk any search returned this turn, newest search last, de-duplicated. */
    public get chunks(): RetrievedChunk[] {
        return [...this.seen.values()];
    }

    public get searchCount(): number {
        return this.searches;
    }

    public get readCount(): number {
        return this.reads;
    }

    /**
     * What the identifier guard may treat as seen besides the search chunks: names established by a
     * listing, a lookup or a result's metadata, and the text of every document read and every
     * definition printed, since what those mention is evidence too.
     */
    public get knownIdentifiers(): string[] {
        return [...this.known, ...this.shownText];
    }

    /** Set once the agent declared it is planning a change; the loop widens its budget on it. */
    public get changePlan(): ChangePlan | undefined {
        return this.plan;
    }

    /** Set once the agent declared it is explaining a mechanism end to end; the loop widens its budget on it too. */
    public get walkthrough(): Walkthrough | undefined {
        return this.walk;
    }

    /** True once a plan or a walkthrough was declared: both earn the wider round budget. */
    public get deepDive(): boolean {
        return this.plan !== undefined || this.walk !== undefined;
    }

    /** The agent's working notes, in the order it wrote them. */
    public get findings(): Finding[] {
        return [...this.notes];
    }

    public async run(call: ToolCall): Promise<string> {
        switch (call.name) {
            case "search_documentation":
                return this.search(call.args);
            case "read_document":
                return this.readDocument(call.args);
            case "open_guide":
                return this.openGuide(call.args);
            case "browse_repository":
                return this.browse(call.args);
            case "find_symbol":
                return this.findSymbol(call.args);
            case "find_references":
                return this.findReferences(call.args);
            case "begin_change_plan":
                return this.beginChangePlan(call.args);
            case "begin_walkthrough":
                return this.beginWalkthrough(call.args);
            case "list_projects":
                return this.listProjects();
            case "recall_conversation":
                return this.recall();
            case "note_findings":
                return this.noteFindings(call.args);
            default:
                // Returned rather than thrown: a model that invents a tool name should be told so
                // and given another turn, not have the question fail.
                return `There is no tool called "${call.name}". Available tools: ${KNOWLEDGE_TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`;
        }
    }

    private async search(args: Record<string, unknown>): Promise<string> {
        const query = stringArg(args, "query");
        if (!query) return "The `query` argument is required and must be a non-empty string.";
        const project = stringArg(args, "project");
        const repo = stringArg(args, "repo");
        const kindArg = stringArg(args, "kind");
        if (kindArg !== undefined && !isDocumentKind(kindArg)) {
            return `\`kind\` must be one of ${DOCUMENT_KINDS.map((k) => `"${k}"`).join(", ")}.`;
        }
        const kind = kindArg !== undefined && isDocumentKind(kindArg) ? kindArg : undefined;

        this.searches += 1;
        let results: RetrievedChunk[];
        try {
            results = await this.knowledgeBase.retrieve(query, {
                numberOfResults: SEARCH_RESULT_COUNT,
                ...retrievalFiltersFor({ project, kind, repo }),
            });
        } catch (err) {
            // The agent is told what went wrong so it can decide — retry, search differently, or
            // tell the user the corpus is unreachable. That decision is not the executor's.
            logger.warn(`Retrieval failed for "${query}": ${(err as Error).message}`);
            return `The search failed: ${(err as Error).message}. The knowledge base may be unreachable.`;
        }

        if (results.length === 0) {
            const scope = [
                project ? `project "${project}"` : "",
                repo ? `repository "${repo}"` : kind && kind !== "all" ? `kind "${kind}"` : "",
            ]
                .filter(Boolean)
                .join(" and ");
            return scope
                ? `No passages matched "${query}" within ${scope}. Try different wording, or search without that restriction.`
                : `No passages matched "${query}" anywhere in the indexed documentation. Try different wording.`;
        }

        logger.debug(
            `search_documentation("${query}"${project ? `, project=${project}` : ""}${kind ? `, kind=${kind}` : ""}${repo ? `, repo=${repo}` : ""}) → ${results.length}`,
        );
        return this.recordAndRender(results);
    }

    /** Keeps what a retrieval returned as evidence, and renders it for the model with the id read_document accepts. */
    private async recordAndRender(results: RetrievedChunk[]): Promise<string> {
        for (const chunk of results) {
            this.seen.set(this.keyOf(chunk), chunk);
            for (const field of ["title", "path", "repo"]) {
                const value = metadataString(chunk, field);
                if (value) this.known.add(value);
            }
        }

        const rendered = await Promise.all(
            results.map(async (chunk, index) => {
                const label = [
                    metadataString(chunk, "project"),
                    metadataString(chunk, "title"),
                    this.sourceLabel(chunk),
                ]
                    .filter((value): value is string => Boolean(value))
                    .join(" · ");
                const id = await this.reader.documentIdOf(chunk.location);
                const idLine = id ? `\ndocument: ${id}` : "";
                return `[${index + 1}]${label ? ` ${label}` : ""}${idLine}\n${chunk.content.trim()}`;
            }),
        );
        return rendered.join("\n\n---\n\n");
    }

    /** "code · workspace/repo:path" for a source file; the source category for anything else. */
    private sourceLabel(chunk: RetrievedChunk): string | undefined {
        const source = metadataString(chunk, "source");
        if (metadataString(chunk, "category") !== CODE_CATEGORY) return source;
        const repo = metadataString(chunk, "repo");
        const path = metadataString(chunk, "path");
        if (repo && path) return `code · ${repo}:${path}`;
        return repo ? `code · ${repo}` : "code";
    }

    /**
     * Content, not location: a document arrives as several chunks under one S3 URI, so keying on
     * the URI alone would collapse a whole document into its first chunk.
     */
    private keyOf(chunk: RetrievedChunk): string {
        return `${chunk.location ?? ""}::${chunk.content.trim().slice(0, 200)}`;
    }

    private async readDocument(args: Record<string, unknown>): Promise<string> {
        const reference = stringArg(args, "document");
        if (!reference)
            return "The `document` argument is required: the `document:` id from a search result, or workspace/repo:path.";
        if (this.reads >= MAX_READS_PER_QUESTION) {
            return `The read budget for this question (${MAX_READS_PER_QUESTION} documents) is used up. Answer from what you have read, or search for a more specific passage.`;
        }
        return this.performRead(reference, {
            startLine: lineArg(args, "startLine"),
            endLine: lineArg(args, "endLine"),
        });
    }

    /**
     * Reads and records a document. `budgeted` is false for an onboarding guide, which has its own
     * smaller allowance so that reading the guides first never starves the code reads that follow.
     */
    private async performRead(reference: string, range: ReadRange, budgeted = true): Promise<string> {
        try {
            const slice = await this.reader.read(reference, range);
            // Charged once the read succeeded, and not for the next part of a document already read:
            // a wrong guess or a long file must not use up the budget the right files need.
            const continuation = this.readKeys.has(slice.key) && range.startLine !== undefined && range.startLine > 1;
            if (budgeted && !continuation) this.reads += 1;
            this.readKeys.add(slice.key);
            for (const identifier of slice.identifiers) this.known.add(identifier);
            // What the file mentions (other paths, settings, scripts) is evidence too; without it a
            // correct step that names them would be revised away as an invention.
            this.shownText.push(slice.content);
            logger.debug(`read ${reference} → ${slice.key}`);
            return slice.content;
        } catch (err) {
            logger.debug(`read ${reference} failed: ${(err as Error).message}`);
            // The reader's messages are written for the agent; nothing raw from S3 reaches it.
            return `Could not read "${reference}": ${(err as Error).message}`;
        }
    }

    /**
     * A guide by name. The repository index knows the exact path, so a set kept in the repository
     * is opened without a search; a set kept in Drive is indexed under the same titles, so the
     * fallback is one search for the title and a read of the result that carries it.
     */
    private async openGuide(args: Record<string, unknown>): Promise<string> {
        const project = stringArg(args, "project");
        if (!project) return "The `project` argument is required: the project's slug, as list_projects shows it.";
        const topic = stringArg(args, "topic");

        let found: Array<{ repo: string; guide: GuideEntry }>;
        try {
            found = await this.guidesOf(project);
        } catch (err) {
            logger.debug(`open_guide(${project}) failed: ${(err as Error).message}`);
            return `Could not read the code index for "${project}": ${(err as Error).message}`;
        }
        for (const { guide } of found) this.known.add(guide.path);

        if (!topic) return this.renderGuides(project, found);

        const wanted = normalizeGuideTopic(topic);
        const match = matchGuide(
            found.map((entry) => entry.guide),
            wanted,
        );
        const owner = match ? found.find((entry) => entry.guide === match) : undefined;
        if (match && owner) {
            const reference = `${owner.repo}:${match.path}`;
            if (this.guides >= MAX_GUIDES_PER_QUESTION) {
                return `You have opened ${MAX_GUIDES_PER_QUESTION} guides this question. Read this one with read_document("${reference}") if you still need it.`;
            }
            this.guides += 1;
            logger.debug(`open_guide(${project}, ${topic}) → ${reference}`);
            return this.performRead(reference, {}, false);
        }

        // Not in a repository: look for the title among the written documentation.
        const title = wanted.number && wanted.slug ? `${wanted.number}-${wanted.slug}` : wanted.slug || topic;
        let results: RetrievedChunk[];
        try {
            this.searches += 1;
            results = await this.knowledgeBase.retrieve(title, {
                numberOfResults: SEARCH_RESULT_COUNT,
                ...retrievalFiltersFor({ project, kind: "docs" }),
            });
        } catch (err) {
            logger.warn(`Guide lookup failed for "${title}": ${(err as Error).message}`);
            return `${this.describeMissingGuide(project, topic, found)} The search for it failed: ${(err as Error).message}.`;
        }

        const titled = results.find((chunk) => {
            const chunkTitle = metadataString(chunk, "title")?.toLowerCase() ?? "";
            return (
                (wanted.number !== undefined && chunkTitle.startsWith(wanted.number)) ||
                (wanted.slug !== "" && chunkTitle.includes(wanted.slug))
            );
        });
        const id = titled ? await this.reader.documentIdOf(titled.location) : undefined;
        if (id && this.guides < MAX_GUIDES_PER_QUESTION) {
            this.guides += 1;
            logger.debug(`open_guide(${project}, ${topic}) → ${id} (by title)`);
            return this.performRead(id, {}, false);
        }

        const rendered = results.length > 0 ? await this.recordAndRender(results) : "";
        return `${this.describeMissingGuide(project, topic, found)}${rendered ? ` The closest written material:\n\n${rendered}` : " Nothing in its written documentation matched the title either."}`;
    }

    private async guidesOf(project: string): Promise<Array<{ repo: string; guide: GuideEntry }>> {
        const repos = await this.codeIndex.repositories(project);
        const indexes = await Promise.all(
            repos.map(async (repo) => ({ repo, index: await this.codeIndex.find(project, repo.folder) })),
        );
        return indexes.flatMap(({ index }) =>
            index ? guidesIn(index.paths).map((guide) => ({ repo: index.fullName, guide })) : [],
        );
    }

    private renderGuides(project: string, found: Array<{ repo: string; guide: GuideEntry }>): string {
        if (found.length === 0) {
            return `Project "${project}" has no ${GUIDE_DIRECTORY} guide set in its indexed repositories. Search its documentation instead (kind "docs").`;
        }
        const lines = found.map(
            ({ repo, guide }) =>
                `- ${guide.number} ${guide.slug} — ${describeGuide(guide) ?? "deep dive"} (${repo}:${guide.path})`,
        );
        return `Guides for project "${project}":\n${lines.join("\n")}\nOpen one with open_guide("${project}", "<name or number>").`;
    }

    private describeMissingGuide(project: string, topic: string, found: Array<{ guide: GuideEntry }>): string {
        const has =
            found.length > 0
                ? ` Its guides are: ${found.map(({ guide }) => `${guide.number} ${guide.slug}`).join(", ")}.`
                : ` It has no ${GUIDE_DIRECTORY} guide set in its indexed repositories.`;
        return `Project "${project}" has no "${topic}" guide.${has}`;
    }

    private async browse(args: Record<string, unknown>): Promise<string> {
        const project = stringArg(args, "project");
        if (!project) return "The `project` argument is required: the project's slug, as list_projects shows it.";
        const repoRef = stringArg(args, "repo");
        const directory = stringArg(args, "directory") ?? "";

        let index: RepoIndex | undefined;
        try {
            if (repoRef) {
                index = await this.codeIndex.find(project, repoRef);
                if (!index) {
                    const repos = await this.codeIndex.repositories(project);
                    return repos.length === 0
                        ? `No source repositories are indexed for project "${project}".`
                        : `Project "${project}" has no repository called "${repoRef}". Its repositories: ${repos.map(repoFullName).join(", ")}.`;
                }
            } else {
                const repos = await this.codeIndex.repositories(project);
                if (repos.length === 0) return `No source repositories are indexed for project "${project}".`;
                if (repos.length > 1 || !directory) {
                    for (const repo of repos) this.known.add(repoFullName(repo));
                    return this.renderRepositories(project, repos);
                }
                index = await this.codeIndex.find(project, repos[0].folder);
                if (!index) return `No source repositories are indexed for project "${project}".`;
            }
        } catch (err) {
            logger.debug(`browse_repository(${project}) failed: ${(err as Error).message}`);
            return `Could not read the code index for "${project}": ${(err as Error).message}`;
        }

        const listing = this.codeIndex.listDirectory(index, directory);
        this.known.add(index.fullName);
        for (const file of listing.files) this.known.add(listing.directory ? `${listing.directory}/${file}` : file);
        for (const dir of listing.subdirectories)
            this.known.add(listing.directory ? `${listing.directory}/${dir.name}` : dir.name);

        if (listing.subdirectories.length === 0 && listing.files.length === 0) {
            return `${index.fullName} has no indexed files under "${listing.directory || "/"}". Browse the root to see what it holds.`;
        }

        const where = listing.directory ? `${index.fullName}/${listing.directory}/` : `${index.fullName}/ (root)`;
        const lines = [
            `${where} — branch ${index.branch}, commit ${index.commit.slice(0, 12)}${index.complete ? "" : " (last sync incomplete)"}`,
            ...listing.subdirectories.map((dir) => `  ${dir.name}/  (${dir.files} file(s))`),
            ...listing.files.map((file) => `  ${file}`),
        ];
        if (listing.omitted > 0)
            lines.push(`  … ${listing.omitted} more entries not shown; list a sub-directory to narrow.`);
        lines.push(`Read a file with read_document("${index.fullName}:<path>").`);
        return lines.join("\n");
    }

    private renderRepositories(project: string, repos: RegistryRepo[]): string {
        const lines = repos.map((repo) => {
            const count = repo.documentCount !== undefined ? `, ${repo.documentCount} file(s)` : "";
            const branch = repo.branch ? ` @ ${repo.branch}` : "";
            const incomplete = repo.complete === false ? ", last sync incomplete" : "";
            return `- ${repoFullName(repo)}${branch}${count}${incomplete}`;
        });
        return `Repositories indexed for project "${project}":\n${lines.join("\n")}\nCall browse_repository again with \`repo\` to list one.`;
    }

    private async findSymbol(args: Record<string, unknown>): Promise<string> {
        const name = stringArg(args, "name");
        if (!name)
            return "The `name` argument is required: a function, class, method, constant, table or resource name.";
        const scope = { project: stringArg(args, "project"), repo: stringArg(args, "repo") };

        let lookup;
        try {
            lookup = await this.codeIndex.findSymbols(name, scope);
        } catch (err) {
            logger.debug(`find_symbol(${name}) failed: ${(err as Error).message}`);
            return `Could not read the symbol index: ${(err as Error).message}`;
        }

        const coverage = this.describeCoverage(lookup.searched, lookup.unindexed);
        if (lookup.matches.length === 0) {
            return `No definition called "${name}" in the indexed code${coverage}. Check the spelling against a search result, or search the code for the name instead.`;
        }

        for (const match of lookup.matches) {
            this.known.add(match.name);
            this.known.add(match.path);
            if (match.parent) this.known.add(`${match.parent}.${match.name}`);
        }
        logger.debug(`find_symbol(${name}) → ${lookup.matches.length} of ${lookup.total}`);

        const lines = lookup.matches.map((match) => this.renderSymbol(match));
        this.shownText.push(...lines);
        const more =
            lookup.total > lookup.matches.length
                ? `\n… ${lookup.total - lookup.matches.length} more; narrow with \`repo\`, or a longer name.`
                : "";
        return `${lookup.matches.length} definition(s) for "${name}"${coverage}:\n${lines.join("\n")}${more}\nRead one with read_document("<repo>:<path>", startLine, endLine).`;
    }

    private renderSymbol(match: SymbolMatch): string {
        const range =
            match.endLine && match.endLine !== match.line ? `${match.line}-${match.endLine}` : `${match.line}`;
        const owner = match.parent ? ` in ${match.parent}` : "";
        const signature = match.signature ? ` — ${match.signature}` : "";
        const doc = match.doc ? `\n    ${match.doc.split("\n")[0].slice(0, 160)}` : "";
        return `- ${match.kind} ${match.name}${owner}: ${match.repo}:${match.path} lines ${range}${signature}${doc}`;
    }

    private async findReferences(args: Record<string, unknown>): Promise<string> {
        const name = stringArg(args, "name");
        if (!name) return "The `name` argument is required: the exact name as written in code.";
        const scope = { project: stringArg(args, "project"), repo: stringArg(args, "repo") };

        let lookup;
        try {
            lookup = await this.codeIndex.findReferences(name, scope);
        } catch (err) {
            logger.debug(`find_references(${name}) failed: ${(err as Error).message}`);
            return `Could not read the symbol index: ${(err as Error).message}`;
        }

        const coverage = this.describeCoverage(lookup.searched, lookup.unindexed);
        if (lookup.definitions.length === 0 && lookup.references.length === 0 && lookup.importers.length === 0) {
            return `Nothing in the indexed code defines, uses or imports "${name}"${coverage}. The index tracks names defined in the repositories; for a table or a setting named only in strings, search the code for it instead.`;
        }

        for (const definition of lookup.definitions) {
            this.known.add(definition.name);
            this.known.add(definition.path);
        }
        for (const hit of [...lookup.references, ...lookup.importers]) this.known.add(hit.path);
        logger.debug(
            `find_references(${name}) → ${lookup.definitions.length} definition(s), ${lookup.totalFiles} file(s), ${lookup.importers.length} importer(s)`,
        );

        const sections: string[] = [`References to "${name}"${coverage}:`];
        if (lookup.definitions.length > 0) {
            const defined = lookup.definitions.map((match) => this.renderSymbol(match));
            this.shownText.push(...defined);
            sections.push(`Defined in:\n${defined.join("\n")}`);
        }
        if (lookup.references.length > 0) {
            const files = lookup.references.map(
                (hit) =>
                    `- ${hit.repo}:${hit.path} line(s) ${hit.lines.slice(0, 12).join(", ")}${hit.lines.length > 12 ? ", …" : ""}`,
            );
            const more =
                lookup.totalFiles > lookup.references.length
                    ? `\n… ${lookup.totalFiles - lookup.references.length} more file(s); narrow with \`repo\`.`
                    : "";
            sections.push(`Used in ${lookup.totalFiles} file(s):\n${files.join("\n")}${more}`);
        }
        if (lookup.importers.length > 0) {
            sections.push(
                `Imported as a module by (matched by module name only, so an unrelated module with the same name can appear):\n${lookup.importers.map((hit) => `- ${hit.repo}:${hit.path} (${hit.module})`).join("\n")}`,
            );
        }
        sections.push("Read the ones that matter with read_document before describing what the change touches.");
        return sections.join("\n");
    }

    private describeCoverage(searched: string[], unindexed: string[]): string {
        if (searched.length === 0 && unindexed.length === 0) return " (no repositories are indexed)";
        const parts: string[] = [];
        if (searched.length > 0) parts.push(`searched ${searched.join(", ")}`);
        if (unindexed.length > 0) parts.push(`no symbol index yet for ${unindexed.join(", ")}`);
        return ` (${parts.join("; ")})`;
    }

    private beginChangePlan(args: Record<string, unknown>): string {
        const goal = stringArg(args, "goal");
        if (!goal) return "The `goal` argument is required: the change, in one sentence.";
        this.plan = { goal, constraints: stringArg(args, "constraints") };
        logger.debug(`begin_change_plan: ${goal}`);
        return changePlanChecklist(this.plan);
    }

    private beginWalkthrough(args: Record<string, unknown>): string {
        const subject = stringArg(args, "subject");
        if (!subject) return "The `subject` argument is required: what is being explained, in one sentence.";
        this.walk = { subject, focus: stringArg(args, "focus") };
        logger.debug(`begin_walkthrough: ${subject}`);
        return walkthroughChecklist(this.walk);
    }

    /** A no-op by design: the value is in the model writing its state down, and in the record it leaves. */
    private noteFindings(args: Record<string, unknown>): string {
        const established = stringArg(args, "established");
        if (!established) return "The `established` argument is required: what you now know, with where it came from.";
        const note: Finding = { established, missing: stringArg(args, "missing"), next: stringArg(args, "next") };
        this.notes.push(note);
        logger.debug(`note_findings #${this.notes.length}: ${established.slice(0, 160)}`);
        const budget = `Searches so far: ${this.searches}; reads: ${this.reads} of ${MAX_READS_PER_QUESTION}.`;
        const missing = note.missing ? `\nStill missing: ${note.missing}` : "";
        const next = note.next ? `\nNext: ${note.next}` : "";
        return `Noted (${this.notes.length}). ${budget}${missing}${next}`;
    }

    private async listProjects(): Promise<string> {
        const { projects } = await this.registry.load();
        if (projects.length === 0) {
            return "No projects are indexed. Only general engineering questions can be answered right now.";
        }
        return projects.map((project) => this.renderProject(project)).join("\n");
    }

    private renderProject(project: RegistryProject): string {
        const count = project.documentCount !== undefined ? `, ${project.documentCount} document(s)` : "";
        const aliases = project.aliases.length > 0 ? `, also called: ${project.aliases.join(", ")}` : "";
        const summary = project.summary ? ` — ${project.summary}` : "";
        const breakdown = project.counts
            ? ` (${Object.entries(project.counts)
                  .map(([category, n]) => `${n} ${category === CODE_CATEGORY ? "code" : category}`)
                  .join(", ")})`
            : "";
        const repos =
            project.repos && project.repos.length > 0
                ? `\n  repositories: ${project.repos
                      .map((repo) => {
                          this.known.add(repoFullName(repo));
                          return `${repoFullName(repo)}${repo.branch ? ` @ ${repo.branch}` : ""}`;
                      })
                      .join(", ")}`
                : "";
        this.known.add(project.slug);
        this.known.add(project.displayName);
        return `- ${project.displayName} [slug: ${project.slug}${count}${breakdown}${aliases}]${summary}${repos}`;
    }

    private async recall(): Promise<string> {
        if (this.history.length === 0) {
            return "Nothing has been asked yet — this is the first question in this conversation.";
        }
        const rendered = this.history
            .map((turn) => {
                const project = turn.resolvedProject ? ` [${turn.resolvedProject}]` : "";
                return `- Asked: "${turn.question}"${project}\n  You answered: ${turn.answerGist}`;
            })
            .join("\n");
        // What was said earlier is something the agent has now seen again.
        this.shownText.push(rendered);
        return rendered;
    }
}

/** Builds an executor bound to this question's conversation history. */
@Service()
export class KnowledgeToolFactory {
    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly reader: DocumentReaderService,
        private readonly codeIndex: CodeIndexService,
    ) {}

    public create(history: ChatTurn[]): KnowledgeToolExecutor {
        return new KnowledgeToolExecutor(this.knowledgeBase, this.registry, this.reader, this.codeIndex, history);
    }
}
