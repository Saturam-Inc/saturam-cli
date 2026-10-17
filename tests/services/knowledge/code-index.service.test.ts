import { CodeIndexService } from "../../../src/services/knowledge/code-index.service";

const state = {
    workspace: "acme",
    repoSlug: "orion-core",
    branch: "main",
    commit: "3f2a9c1deadbeef0123456789abcdef012345678",
    indexedAt: "2026-10-14T15:57:16Z",
    version: 2,
    planned: 4,
    complete: true,
    keys: [
        "orion/bitbucket/orion-core/_repository.md",
        "orion/bitbucket/orion-core/README.md.md",
        "orion/bitbucket/orion-core/jobs/nightly.py.md",
        "orion/bitbucket/orion-core/jobs/utils/io.py.md",
        "orion/bitbucket/orion-core/infra/main.tf.md",
        "orion/bitbucket/orion-core/pkg/__init__.py.md",
        "orion/bitbucket/orion-core/__main__.py.md",
    ],
};

const registered = {
    workspace: "acme",
    repoSlug: "orion-core",
    folder: "orion-core",
    branch: "main",
    documentCount: 5,
};

describe("CodeIndexService", () => {
    let s3: any;
    let registry: any;
    let service: CodeIndexService;

    beforeEach(() => {
        s3 = {
            getStateObject: jest.fn().mockResolvedValue(Buffer.from(JSON.stringify(state))),
            listStateObjects: jest.fn().mockResolvedValue(["onboarding-state/code-index/orion/orion-core.json"]),
        };
        registry = { reposOf: jest.fn().mockResolvedValue([registered]) };
        service = new CodeIndexService(s3, registry);
    });

    it("lists a project's repositories from the registry without touching S3", async () => {
        await expect(service.repositories("orion")).resolves.toEqual([registered]);
        expect(s3.listStateObjects).not.toHaveBeenCalled();
    });

    it("falls back to listing the state prefix for a registry that predates repositories", async () => {
        registry.reposOf.mockResolvedValue([]);

        const repos = await service.repositories("orion");

        expect(s3.listStateObjects).toHaveBeenCalledWith("code-index/orion");
        expect(repos).toMatchObject([
            { workspace: "acme", repoSlug: "orion-core", folder: "orion-core", documentCount: 6 },
        ]);
    });

    it("remembers an empty or failed fallback listing instead of repeating it on every call", async () => {
        registry.reposOf.mockResolvedValue([]);
        s3.listStateObjects.mockRejectedValue(new Error("AccessDenied"));

        await expect(service.repositories("orion")).resolves.toEqual([]);
        await expect(service.repositories("orion")).resolves.toEqual([]);

        expect(s3.listStateObjects).toHaveBeenCalledTimes(1);
    });

    it("loads a repository's files from the state file, dropping the pipeline's own index document", async () => {
        const index = await service.load("orion", "orion-core");

        expect(s3.getStateObject).toHaveBeenCalledWith("code-index/orion/orion-core.json");
        expect(index).toMatchObject({ fullName: "acme/orion-core", branch: "main", complete: true });
        expect(index?.paths).toEqual([
            "README.md",
            "__main__.py",
            "infra/main.tf",
            "jobs/nightly.py",
            "jobs/utils/io.py",
            "pkg/__init__.py",
        ]);
    });

    it("finds a repository by slug, folder or full name, in any case", async () => {
        await expect(service.find("orion", "ACME/orion-core")).resolves.toMatchObject({ folder: "orion-core" });
        await expect(service.find("orion", "orion-core")).resolves.toMatchObject({ folder: "orion-core" });
        await expect(service.find("orion", "nowhere")).resolves.toBeUndefined();
    });

    it("lists one level of the tree, with a file count under each sub-directory", async () => {
        const index = (await service.load("orion", "orion-core"))!;

        const root = service.listDirectory(index);
        expect(root.subdirectories).toEqual([
            { name: "infra", files: 1 },
            { name: "jobs", files: 2 },
            { name: "pkg", files: 1 },
        ]);
        expect(root.files).toEqual(["README.md", "__main__.py"]);

        const jobs = service.listDirectory(index, "jobs/");
        expect(jobs).toMatchObject({
            directory: "jobs",
            subdirectories: [{ name: "utils", files: 1 }],
            files: ["nightly.py"],
        });
    });

    it("caches an index so a conversation does not re-read the state file on every call", async () => {
        await service.load("orion", "orion-core");
        await service.load("orion", "orion-core");

        expect(s3.getStateObject).toHaveBeenCalledTimes(1);
    });

    it("is undefined when there is no state file, rather than throwing into the agent", async () => {
        s3.getStateObject.mockRejectedValue(new Error("NoSuchKey"));

        await expect(service.load("orion", "orion-core")).resolves.toBeUndefined();
    });

    describe("symbol index", () => {
        const symbols = {
            version: 1,
            commit: state.commit,
            symbols: [
                {
                    name: "run",
                    kind: "function",
                    path: "jobs/nightly.py",
                    line: 12,
                    endLine: 30,
                    signature: "def run(day)",
                },
                { name: "Scheduler", kind: "class", path: "jobs/scheduler.py", line: 5, endLine: 90 },
                { name: "run", kind: "method", path: "jobs/scheduler.py", line: 40, endLine: 60, parent: "Scheduler" },
                { name: "run_all", kind: "function", path: "jobs/utils/io.py", line: 3 },
                { name: "JOBS_TABLE", kind: "constant", path: "jobs/nightly.py", line: 4 },
            ],
            references: [
                { name: "run", path: "jobs/scheduler.py", lines: [44, 51] },
                { name: "run", path: "tests/test_nightly.py", lines: [7] },
                { name: "JOBS_TABLE", path: "jobs/scheduler.py", lines: [12] },
            ],
            imports: [
                { path: "jobs/scheduler.py", modules: ["jobs.nightly", "os"] },
                { path: "tests/test_nightly.py", modules: ["../jobs/nightly"] },
                { path: "jobs/settings.py", modules: ["./config.yaml"] },
            ],
        };

        beforeEach(() => {
            s3.getStateObject.mockImplementation(async (key: string) =>
                Buffer.from(JSON.stringify(key.endsWith(".symbols.json") ? symbols : state)),
            );
            registry.load = jest.fn().mockResolvedValue({ projects: [{ slug: "orion", repos: [registered] }] });
        });

        it("reads the symbols file beside the state file, once", async () => {
            await service.loadSymbols("orion", "orion-core");
            await service.loadSymbols("orion", "orion-core");

            expect(s3.getStateObject).toHaveBeenCalledWith("code-index/orion/orion-core.symbols.json");
            expect(s3.getStateObject).toHaveBeenCalledTimes(1);
        });

        it("ranks an exact name first, then other cases, then partial matches", async () => {
            const lookup = await service.findSymbols("run", { project: "orion" });

            expect(lookup.matches.map((m) => `${m.kind} ${m.name}@${m.path}`)).toEqual([
                "function run@jobs/nightly.py",
                "method run@jobs/scheduler.py",
                "function run_all@jobs/utils/io.py",
            ]);
            expect(lookup.matches[0]).toMatchObject({ repo: "acme/orion-core", projectSlug: "orion" });
            expect(lookup.searched).toEqual(["acme/orion-core"]);
        });

        it("prefers the method of the named class for a dotted name", async () => {
            const lookup = await service.findSymbols("Scheduler.run", { project: "orion" });

            expect(lookup.matches[0]).toMatchObject({ kind: "method", parent: "Scheduler", path: "jobs/scheduler.py" });
        });

        it("searches every project when none is given, and reports repositories without an index", async () => {
            s3.getStateObject.mockImplementation(async (key: string) => {
                if (key.endsWith(".symbols.json")) throw new Error("NoSuchKey");
                return Buffer.from(JSON.stringify(state));
            });

            const lookup = await service.findSymbols("run");

            expect(registry.load).toHaveBeenCalled();
            expect(lookup.matches).toEqual([]);
            expect(lookup.unindexed).toEqual(["acme/orion-core"]);
        });

        it("finds references by exact name, with the definitions and the importers of the module", async () => {
            const lookup = await service.findReferences("nightly.run", { project: "orion", repo: "orion-core" });

            expect(lookup.definitions.map((d) => `${d.kind}@${d.path}`)).toEqual([
                "function@jobs/nightly.py",
                "method@jobs/scheduler.py",
            ]);
            expect(lookup.references).toEqual([
                { projectSlug: "orion", repo: "acme/orion-core", path: "jobs/scheduler.py", lines: [44, 51] },
                { projectSlug: "orion", repo: "acme/orion-core", path: "tests/test_nightly.py", lines: [7] },
            ]);
            // "jobs.nightly" and "../jobs/nightly" both name the module `nightly`; `run` is not a module.
            expect(lookup.importers).toEqual([]);
            expect(lookup.totalFiles).toBe(2);
        });

        it("treats a query with a file extension as the module, not a symbol called after the extension", async () => {
            const lookup = await service.findReferences("nightly.py", { project: "orion" });

            expect(lookup.importers.map((hit) => hit.path)).toEqual(["jobs/scheduler.py", "tests/test_nightly.py"]);
            expect(lookup.definitions).toEqual([]);

            // The same strip applies to the import, so a data file meets the module that loads it.
            const yaml = await service.findReferences("config.yaml", { project: "orion" });
            expect(yaml.importers.map((hit) => hit.path)).toEqual(["jobs/settings.py"]);
        });

        it("finds the files that import a module by its last segment, however the path is written", async () => {
            const lookup = await service.findReferences("jobs/nightly.py", { project: "orion" });

            expect(lookup.importers.map((hit) => `${hit.path} (${hit.module})`)).toEqual([
                "jobs/scheduler.py (jobs.nightly)",
                "tests/test_nightly.py (../jobs/nightly)",
            ]);
        });
    });
});
