import { findUnsupportedIdentifiers } from "../../../../src/services/knowledge/unsupported-identifiers";
import {
    KNOWLEDGE_TOOL_DEFINITIONS,
    KnowledgeToolExecutor,
    MAX_READS_PER_QUESTION,
} from "../../../../src/services/knowledge/agent/knowledge-tools";

const codeChunk = {
    content: "def run():\n    return os.getenv('JOBS_TABLE')",
    location: "s3://kb/onboarding/orion/bitbucket/orion-core/jobs/nightly.py.md",
    score: 0.6,
    metadata: {
        project: "orion",
        title: "orion-core/jobs/nightly.py",
        source: "bitbucket",
        category: "bitbucket",
        repo: "acme/orion-core",
        path: "jobs/nightly.py",
    },
};

const docChunk = {
    content: "The nightly job runs at 01:30.",
    location: "s3://kb/onboarding/orion/google-docs/12-jobs.md",
    score: 0.5,
    metadata: { project: "orion", title: "12-jobs", source: "google-docs", category: "google-docs" },
};

const repo = { workspace: "acme", repoSlug: "orion-core", folder: "orion-core", branch: "main", documentCount: 4 };

const index = {
    projectSlug: "orion",
    folder: "orion-core",
    workspace: "acme",
    repoSlug: "orion-core",
    fullName: "acme/orion-core",
    branch: "main",
    commit: "3f2a9c1deadbeef0123456789abcdef012345678",
    complete: true,
    paths: ["README.md", "jobs/nightly.py", "jobs/utils/io.py"],
};

const project = {
    slug: "orion",
    displayName: "Orion",
    aliases: [],
    documentCount: 555,
    sources: ["bitbucket", "google-docs"],
    counts: { "google-docs": 24, bitbucket: 531 },
    repos: [repo],
};

describe("KnowledgeToolExecutor", () => {
    let knowledgeBase: any;
    let registry: any;
    let reader: any;
    let codeIndex: any;
    let executor: KnowledgeToolExecutor;

    const run = (name: string, args: Record<string, unknown> = {}) => executor.run({ id: "c1", name, args });

    beforeEach(() => {
        knowledgeBase = { retrieve: jest.fn().mockResolvedValue([codeChunk, docChunk]) };
        registry = { load: jest.fn().mockResolvedValue({ projects: [project] }) };
        reader = {
            documentIdOf: jest.fn(async (location?: string) => location?.replace("s3://kb/onboarding/", "")),
            read: jest.fn().mockResolvedValue({
                key: "orion/bitbucket/orion-core/jobs/nightly.py.md",
                path: "jobs/nightly.py",
                content: "1 | def run():",
                identifiers: ["jobs/nightly.py", "orion/bitbucket/orion-core/jobs/nightly.py.md"],
            }),
        };
        codeIndex = {
            repositories: jest.fn().mockResolvedValue([repo]),
            find: jest.fn().mockResolvedValue(index),
            listDirectory: jest.fn().mockReturnValue({
                directory: "jobs",
                subdirectories: [{ name: "utils", files: 1 }],
                files: ["nightly.py"],
                omitted: 0,
            }),
            findSymbols: jest.fn().mockResolvedValue({
                matches: [
                    {
                        name: "run",
                        kind: "function",
                        path: "jobs/nightly.py",
                        line: 12,
                        endLine: 30,
                        signature: "def run(day: date) -> int",
                        doc: "Builds the daily table.",
                        projectSlug: "orion",
                        repo: "acme/orion-core",
                    },
                ],
                total: 1,
                searched: ["acme/orion-core"],
                unindexed: [],
            }),
            findReferences: jest.fn().mockResolvedValue({
                definitions: [
                    {
                        name: "run",
                        kind: "function",
                        path: "jobs/nightly.py",
                        line: 12,
                        projectSlug: "orion",
                        repo: "acme/orion-core",
                    },
                ],
                references: [
                    { projectSlug: "orion", repo: "acme/orion-core", path: "jobs/scheduler.py", lines: [40, 88] },
                    { projectSlug: "orion", repo: "acme/orion-core", path: "tests/test_nightly.py", lines: [7] },
                ],
                importers: [
                    {
                        projectSlug: "orion",
                        repo: "acme/orion-core",
                        path: "jobs/scheduler.py",
                        module: "jobs.nightly",
                    },
                ],
                totalFiles: 2,
                searched: ["acme/orion-core"],
                unindexed: [],
            }),
        };
        executor = new KnowledgeToolExecutor(knowledgeBase, registry, reader, codeIndex, []);
    });

    it("offers search, read, guides, browse, the symbol lookups, the two declarations, list, recall and notes", () => {
        expect(KNOWLEDGE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
            "search_documentation",
            "read_document",
            "open_guide",
            "browse_repository",
            "find_symbol",
            "find_references",
            "begin_change_plan",
            "begin_walkthrough",
            "list_projects",
            "recall_conversation",
            "note_findings",
        ]);
    });

    describe("open_guide", () => {
        const guides = [
            "docs/onboarding/00-overview.md",
            "docs/onboarding/03-architecture.md",
            "docs/onboarding/22-airflow-triggering-strategy.md",
            "docs/onboarding/25-change-impact-map.md",
        ];

        beforeEach(() => {
            codeIndex.find.mockResolvedValue({ ...index, paths: [...index.paths, ...guides] });
        });

        it("lists the project's guides, with what each holds, when no topic is given", async () => {
            const reply = await run("open_guide", { project: "orion" });

            expect(reply).toContain("03 architecture — components, how they communicate");
            expect(reply).toContain("22 airflow-triggering-strategy — deep dive");
            expect(reply).toContain("acme/orion-core:docs/onboarding/25-change-impact-map.md");
            expect(executor.knownIdentifiers).toContain("docs/onboarding/03-architecture.md");
            expect(reader.read).not.toHaveBeenCalled();
        });

        it("opens a guide by name, number or alias, without charging the read budget", async () => {
            await run("open_guide", { project: "orion", topic: "architecture" });
            await run("open_guide", { project: "orion", topic: "25" });
            await run("open_guide", { project: "orion", topic: "the impact map" });
            await run("open_guide", { project: "orion", topic: "airflow" });

            expect(reader.read.mock.calls.map((call: unknown[]) => call[0])).toEqual([
                "acme/orion-core:docs/onboarding/03-architecture.md",
                "acme/orion-core:docs/onboarding/25-change-impact-map.md",
                "acme/orion-core:docs/onboarding/25-change-impact-map.md",
                "acme/orion-core:docs/onboarding/22-airflow-triggering-strategy.md",
            ]);
            expect(executor.readCount).toBe(0);
        });

        it("falls back to the written documentation and reads the document that carries the title", async () => {
            codeIndex.find.mockResolvedValue(index);
            knowledgeBase.retrieve.mockResolvedValue([
                {
                    ...docChunk,
                    location: "s3://kb/onboarding/orion/google-docs/03-architecture.md",
                    metadata: { ...docChunk.metadata, title: "03-architecture" },
                },
            ]);

            await run("open_guide", { project: "orion", topic: "architecture" });

            expect(knowledgeBase.retrieve).toHaveBeenCalledWith("03-architecture", expect.anything());
            expect(reader.read).toHaveBeenCalledWith("orion/google-docs/03-architecture.md", {});
            expect(executor.readCount).toBe(0);
        });

        it("says plainly when the project has no such guide, and shows the nearest passages", async () => {
            codeIndex.find.mockResolvedValue(index);
            knowledgeBase.retrieve.mockResolvedValue([docChunk]);

            const reply = await run("open_guide", { project: "orion", topic: "decisions" });

            expect(reply).toContain('Project "orion" has no "decisions" guide.');
            expect(reply).toContain("12-jobs");
            expect(reader.read).not.toHaveBeenCalled();
        });

        it("requires a project", async () => {
            expect(await run("open_guide", {})).toContain("`project` argument is required");
        });
    });

    describe("begin_walkthrough", () => {
        it("records the subject, widens the budget and returns the method to work through", async () => {
            const reply = await run("begin_walkthrough", {
                subject: "how the nightly pipeline runs",
                focus: "the triggers",
            });

            expect(reply).toContain("Walkthrough recorded: how the nightly pipeline runs Focus: the triggers");
            expect(reply).toContain("1. Boundaries");
            expect(reply).toContain("3. The path");
            expect(reply).toContain("Design decisions and trade-offs");
            expect(executor.walkthrough).toEqual({ subject: "how the nightly pipeline runs", focus: "the triggers" });
            expect(executor.deepDive).toBe(true);
        });

        it("requires a subject and records nothing without one", async () => {
            expect(await run("begin_walkthrough", {})).toContain("`subject` argument is required");
            expect(executor.walkthrough).toBeUndefined();
            expect(executor.deepDive).toBe(false);
        });
    });

    describe("note_findings", () => {
        it("keeps the note and reports the budget used so far", async () => {
            await run("search_documentation", { query: "nightly" });

            const reply = await run("note_findings", {
                established: "the daemon in jobs/daemon.py triggers nightly.run",
                missing: "what resets the raw tables first",
                next: "find_references(reset_raw_tables)",
            });

            expect(reply).toContain("Noted (1). Searches so far: 1; reads: 0 of");
            expect(reply).toContain("Still missing: what resets the raw tables first");
            expect(reply).toContain("Next: find_references(reset_raw_tables)");
            expect(executor.findings).toEqual([
                {
                    established: "the daemon in jobs/daemon.py triggers nightly.run",
                    missing: "what resets the raw tables first",
                    next: "find_references(reset_raw_tables)",
                },
            ]);
        });

        it("requires something established", async () => {
            expect(await run("note_findings", {})).toContain("`established` argument is required");
            expect(executor.findings).toEqual([]);
        });
    });

    describe("find_symbol", () => {
        it("renders each definition with its place, signature and docstring, and records the names", async () => {
            const reply = await run("find_symbol", { name: "run", project: "orion" });

            expect(codeIndex.findSymbols).toHaveBeenCalledWith("run", { project: "orion", repo: undefined });
            expect(reply).toContain('1 definition(s) for "run" (searched acme/orion-core)');
            expect(reply).toContain(
                "- function run: acme/orion-core:jobs/nightly.py lines 12-30 — def run(day: date) -> int",
            );
            expect(reply).toContain("Builds the daily table.");
            expect(executor.knownIdentifiers).toEqual(expect.arrayContaining(["run", "jobs/nightly.py"]));
        });

        it("records the signature and docstring it printed as seen", async () => {
            await run("find_symbol", { name: "run", project: "orion" });

            expect(
                findUnsupportedIdentifiers("`run(day: date)` builds the table.", "", [], executor.knownIdentifiers),
            ).toEqual([]);
        });

        it("says which repositories have no symbol index yet, so a miss is not read as absence", async () => {
            codeIndex.findSymbols.mockResolvedValue({
                matches: [],
                total: 0,
                searched: [],
                unindexed: ["acme/orion-core"],
            });

            const reply = await run("find_symbol", { name: "nowhere" });

            expect(reply).toContain('No definition called "nowhere"');
            expect(reply).toContain("no symbol index yet for acme/orion-core");
        });

        it("requires a name", async () => {
            expect(await run("find_symbol", {})).toContain("`name` argument is required");
        });
    });

    describe("find_references", () => {
        it("lists the definitions, the using files with lines, and the importers", async () => {
            const reply = await run("find_references", { name: "run" });

            expect(reply).toContain("Defined in:");
            expect(reply).toContain("Used in 2 file(s):");
            expect(reply).toContain("- acme/orion-core:jobs/scheduler.py line(s) 40, 88");
            expect(reply).toContain("- acme/orion-core:tests/test_nightly.py line(s) 7");
            // The importer list says it matches by module name, so the agent does not present it as exact impact.
            expect(reply).toMatch(
                /Imported as a module by \(matched by module name only.*\):\n- acme\/orion-core:jobs\/scheduler\.py \(jobs\.nightly\)/,
            );
            expect(executor.knownIdentifiers).toEqual(
                expect.arrayContaining(["jobs/scheduler.py", "tests/test_nightly.py"]),
            );
        });

        it("says so plainly when nothing defines, uses or imports the name", async () => {
            codeIndex.findReferences.mockResolvedValue({
                definitions: [],
                references: [],
                importers: [],
                totalFiles: 0,
                searched: ["acme/orion-core"],
                unindexed: [],
            });

            expect(await run("find_references", { name: "ghost" })).toContain(
                'Nothing in the indexed code defines, uses or imports "ghost"',
            );
        });
    });

    describe("begin_change_plan", () => {
        it("records the goal and returns the checklist to work through", async () => {
            const reply = await run("begin_change_plan", {
                goal: "move the nightly job to 03:00",
                constraints: "no downtime",
            });

            expect(executor.changePlan).toEqual({ goal: "move the nightly job to 03:00", constraints: "no downtime" });
            expect(reply).toContain("Plan recorded: move the nightly job to 03:00 Constraints: no downtime");
            expect(reply).toContain("1. Locate");
            expect(reply).toContain("find_references for every use");
            expect(reply).toContain("change-impact-map and making-changes guides first (open_guide)");
            expect(reply).toContain("Write the plan as numbered steps");
        });

        it("requires a goal and records nothing without one", async () => {
            expect(await run("begin_change_plan", {})).toContain("`goal` argument is required");
            expect(executor.changePlan).toBeUndefined();
        });
    });

    describe("search_documentation", () => {
        it("searches everything when no kind is given, with no filter at all", async () => {
            await run("search_documentation", { query: "nightly job" });

            const [, options] = knowledgeBase.retrieve.mock.calls[0];
            expect(options).toEqual({ numberOfResults: 12 });
        });

        it("narrows to code through the category, and to one repository", async () => {
            await run("search_documentation", { query: "nightly job", kind: "code" });
            expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
                "nightly job",
                expect.objectContaining({ category: "bitbucket" }),
            );

            await run("search_documentation", { query: "nightly job", repo: "acme/orion-core" });
            expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
                "nightly job",
                expect.objectContaining({ repo: "acme/orion-core", category: "bitbucket" }),
            );
        });

        it("narrows to prose by excluding the code category", async () => {
            await run("search_documentation", { query: "nightly job", kind: "docs", project: "orion" });

            expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
                "nightly job",
                expect.objectContaining({ project: "orion", excludeCategory: "bitbucket" }),
            );
        });

        it("rejects an unknown kind without searching", async () => {
            const reply = await run("search_documentation", { query: "nightly job", kind: "tests" });

            expect(reply).toContain("`kind` must be one of");
            expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
        });

        it("labels code results with repo:path and gives every result a document id", async () => {
            const reply = await run("search_documentation", { query: "nightly job" });

            expect(reply).toContain("[1] orion · orion-core/jobs/nightly.py · code · acme/orion-core:jobs/nightly.py");
            expect(reply).toContain("document: orion/bitbucket/orion-core/jobs/nightly.py.md");
            expect(reply).toContain("[2] orion · 12-jobs · google-docs");
            expect(reply).toContain("document: orion/google-docs/12-jobs.md");
        });

        it("remembers the titles, paths and repositories of results as names it saw", async () => {
            await run("search_documentation", { query: "nightly job" });

            expect(executor.knownIdentifiers).toEqual(
                expect.arrayContaining(["jobs/nightly.py", "acme/orion-core", "orion-core/jobs/nightly.py", "12-jobs"]),
            );
        });

        it("says what scope an empty search had, so the agent can widen it", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            const reply = await run("search_documentation", { query: "billing", kind: "code", project: "orion" });

            expect(reply).toContain('No passages matched "billing" within project "orion" and kind "code"');
        });
    });

    describe("read_document", () => {
        it("reads through the reader and records what it saw", async () => {
            const reply = await run("read_document", { document: "acme/orion-core:jobs/nightly.py" });

            expect(reader.read).toHaveBeenCalledWith("acme/orion-core:jobs/nightly.py", {
                startLine: undefined,
                endLine: undefined,
            });
            expect(reply).toBe("1 | def run():");
            expect(executor.readCount).toBe(1);
            expect(executor.knownIdentifiers).toContain("jobs/nightly.py");
        });

        it("passes a line range through", async () => {
            await run("read_document", { document: "orion/google-docs/12-jobs.md", startLine: 10, endLine: 20 });

            expect(reader.read).toHaveBeenCalledWith("orion/google-docs/12-jobs.md", { startLine: 10, endLine: 20 });
        });

        it("reports a failed read to the agent rather than failing the question", async () => {
            reader.read.mockRejectedValue(new Error('There is no document at "x".'));

            const reply = await run("read_document", { document: "x" });

            expect(reply).toContain('Could not read "x": There is no document at "x".');
        });

        it("treats what a file mentions as seen, so a correct step naming it is not flagged", async () => {
            reader.read.mockResolvedValue({
                key: "orion/bitbucket/orion-core/jobs/nightly.py.md",
                path: "jobs/nightly.py",
                content: '1 | CONFIG = "config/schedule.yaml"\n2 | run("scripts/run_nightly.sh")',
                identifiers: ["jobs/nightly.py"],
            });
            await run("read_document", { document: "acme/orion-core:jobs/nightly.py" });

            const unsupported = findUnsupportedIdentifiers(
                "Edit `config/schedule.yaml`, then check `scripts/run_nightly.sh`.",
                "",
                [],
                executor.knownIdentifiers,
            );

            expect(unsupported).toEqual([]);
            // A name the agent never saw is still caught.
            expect(
                findUnsupportedIdentifiers("Edit `config/invented.yaml`.", "", [], executor.knownIdentifiers),
            ).toEqual(["config/invented.yaml"]);
        });

        it("does not charge the budget for a failed read", async () => {
            reader.read.mockRejectedValue(new Error('There is no document at "x".'));
            await run("read_document", { document: "x" });
            await run("read_document", { document: "y" });

            expect(executor.readCount).toBe(0);
        });

        it("does not charge the budget for the next part of a document already read", async () => {
            await run("read_document", { document: "acme/orion-core:jobs/nightly.py" });
            await run("read_document", { document: "acme/orion-core:jobs/nightly.py", startLine: 500 });
            await run("read_document", { document: "acme/orion-core:jobs/nightly.py", startLine: 900 });

            expect(executor.readCount).toBe(1);
        });

        it("stops at the read budget and says so", async () => {
            reader.read.mockImplementation(async (reference: string) => ({
                key: reference,
                content: "text",
                identifiers: [],
            }));
            for (let i = 0; i < MAX_READS_PER_QUESTION; i += 1) {
                await run("read_document", { document: `orion/google-docs/doc-${i}.md` });
            }

            const reply = await run("read_document", { document: "orion/google-docs/12-jobs.md" });

            expect(reply).toContain("read budget");
            expect(reader.read).toHaveBeenCalledTimes(MAX_READS_PER_QUESTION);
        });

        it("requires a document reference", async () => {
            expect(await run("read_document", {})).toContain("`document` argument is required");
        });
    });

    describe("browse_repository", () => {
        it("lists a project's repositories when none is named", async () => {
            codeIndex.repositories.mockResolvedValue([repo, { ...repo, repoSlug: "orion-ui", folder: "orion-ui" }]);

            const reply = await run("browse_repository", { project: "orion" });

            expect(reply).toContain('Repositories indexed for project "orion"');
            expect(reply).toContain("- acme/orion-core @ main, 4 file(s)");
            expect(reply).toContain("- acme/orion-ui @ main");
            expect(executor.knownIdentifiers).toContain("acme/orion-core");
        });

        it("lists one directory with sub-directory counts, and says how to read a file", async () => {
            const reply = await run("browse_repository", { project: "orion", repo: "orion-core", directory: "jobs" });

            expect(codeIndex.find).toHaveBeenCalledWith("orion", "orion-core");
            expect(codeIndex.listDirectory).toHaveBeenCalledWith(index, "jobs");
            expect(reply).toContain("acme/orion-core/jobs/ — branch main, commit 3f2a9c1deadb");
            expect(reply).toContain("utils/  (1 file(s))");
            expect(reply).toContain("  nightly.py");
            expect(reply).toContain('read_document("acme/orion-core:<path>")');
            expect(executor.knownIdentifiers).toEqual(expect.arrayContaining(["jobs/nightly.py", "jobs/utils"]));
        });

        it("falls through to the only repository when a directory is given without a repo", async () => {
            await run("browse_repository", { project: "orion", directory: "jobs" });

            expect(codeIndex.find).toHaveBeenCalledWith("orion", "orion-core");
        });

        it("names the repositories when the one asked for does not exist", async () => {
            codeIndex.find.mockResolvedValue(undefined);

            const reply = await run("browse_repository", { project: "orion", repo: "nowhere" });

            expect(reply).toContain('no repository called "nowhere"');
            expect(reply).toContain("acme/orion-core");
        });

        it("says so when a project has no indexed code", async () => {
            codeIndex.repositories.mockResolvedValue([]);

            expect(await run("browse_repository", { project: "orion" })).toContain(
                "No source repositories are indexed",
            );
        });

        it("requires a project", async () => {
            expect(await run("browse_repository", {})).toContain("`project` argument is required");
        });
    });

    describe("list_projects", () => {
        it("renders the per-category counts and the repositories", async () => {
            const reply = await run("list_projects");

            expect(reply).toContain("Orion [slug: orion, 555 document(s) (24 google-docs, 531 code)]");
            expect(reply).toContain("repositories: acme/orion-core @ main");
        });
    });
});
