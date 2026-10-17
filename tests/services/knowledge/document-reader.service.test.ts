import { S3ObjectError } from "../../../src/integrations/aws/services/s3.service";
import { DocumentReaderService, MAX_READ_CHARS } from "../../../src/services/knowledge/document-reader.service";

/** A source file as the pipeline writes it: header table, "## Source", the file in a fence. */
const codeDocument = `# orion-core/jobs/nightly.py

| Field | Value |
| :--- | :--- |
| **Repository** | acme/orion-core |
| **Branch** | main |
| **Commit** | 3f2a9c1deadb (2026-09-30) |
| **Path** | jobs/nightly.py |
| **Language** | python |

## Source

\`\`\`\`python
import os


def run():
    return os.getenv("JOBS_TABLE")
\`\`\`\`
`;

const proseDocument = "# Overview\n\nFirst line.\nSecond line.\n\n## Document set\n\n- a\n";

const notFound = (key: string) => new Error(`Failed to get s3://kb-bucket/onboarding/${key}: NoSuchKey`);

describe("DocumentReaderService", () => {
    let s3: any;
    let config: any;
    let registry: any;
    let reader: DocumentReaderService;

    beforeEach(() => {
        s3 = { getObject: jest.fn() };
        config = {
            getS3Config: jest.fn().mockResolvedValue({
                bucket: "kb-bucket",
                prefix: "onboarding",
                statePrefix: "onboarding-state",
                region: "ap-south-1",
            }),
        };
        registry = {
            load: jest.fn().mockResolvedValue({
                projects: [
                    {
                        slug: "orion",
                        displayName: "Orion",
                        aliases: [],
                        sources: ["bitbucket"],
                        repos: [{ workspace: "acme", repoSlug: "orion-core", folder: "orion-core", branch: "main" }],
                    },
                ],
            }),
        };
        reader = new DocumentReaderService(s3, config, registry);
    });

    describe("documentIdOf", () => {
        it("turns a chunk's S3 URI into the content-relative key the agent can read back", async () => {
            await expect(
                reader.documentIdOf("s3://kb-bucket/onboarding/orion/google-docs/00-overview.md"),
            ).resolves.toBe("orion/google-docs/00-overview.md");
        });

        it("is undefined for a URI from another bucket or outside the content prefix", async () => {
            await expect(reader.documentIdOf("s3://other/onboarding/orion/x.md")).resolves.toBeUndefined();
            // "onboarding" must not match the sibling "onboarding-state" prefix.
            await expect(reader.documentIdOf("s3://kb-bucket/onboarding-state/registry.json")).resolves.toBeUndefined();
        });

        it("is undefined when S3 is not configured, rather than failing the search", async () => {
            config.getS3Config.mockRejectedValue(new Error("S3 is not configured"));
            await expect(reader.documentIdOf("s3://kb-bucket/onboarding/orion/x.md")).resolves.toBeUndefined();
        });
    });

    describe("resolveKey", () => {
        it("accepts the document id a search result showed", async () => {
            await expect(reader.resolveKey("orion/google-docs/00-overview.md")).resolves.toBe(
                "orion/google-docs/00-overview.md",
            );
        });

        it("appends .md to a path without it, since every document in the corpus carries one", async () => {
            await expect(reader.resolveKey("orion/bitbucket/orion-core/jobs/nightly.py")).resolves.toBe(
                "orion/bitbucket/orion-core/jobs/nightly.py.md",
            );
        });

        it("resolves workspace/repo:path through the registry, by full name or slug", async () => {
            await expect(reader.resolveKey("acme/orion-core:jobs/nightly.py")).resolves.toBe(
                "orion/bitbucket/orion-core/jobs/nightly.py.md",
            );
        });

        it("refuses an unknown repository with a hint about where to find the name", async () => {
            await expect(reader.resolveKey("acme/nowhere:jobs/nightly.py")).rejects.toThrow(
                /No indexed repository is called "acme\/nowhere"/,
            );
        });

        it("refuses a path that climbs out of the content prefix", async () => {
            await expect(reader.resolveKey("../onboarding-state/registry.json")).rejects.toThrow(
                "is not a document reference",
            );
        });

        it("refuses an S3 URI that is not under this deployment's bucket and prefix", async () => {
            await expect(reader.resolveKey("s3://kb-bucket/onboarding-state/registry.json")).rejects.toThrow(
                "not under this deployment's documentation bucket",
            );
        });
    });

    describe("read", () => {
        it("numbers a source file's lines from the fence, keeping the header above them", async () => {
            s3.getObject.mockResolvedValue(Buffer.from(codeDocument));

            const slice = await reader.read("acme/orion-core:jobs/nightly.py");

            expect(s3.getObject).toHaveBeenCalledWith("orion/bitbucket/orion-core/jobs/nightly.py.md");
            expect(slice.path).toBe("jobs/nightly.py");
            expect(slice.content).toContain("| **Path** | jobs/nightly.py |");
            expect(slice.content).toContain("Source lines 1–5 of 5 (jobs/nightly.py)");
            expect(slice.content).toContain("1 | import os");
            expect(slice.content).toContain("4 | def run():");
            expect(slice.content).not.toContain("````");
            expect(slice.identifiers).toEqual(expect.arrayContaining(["jobs/nightly.py", slice.key]));
        });

        it("reads a line range of a source file and says how to continue", async () => {
            s3.getObject.mockResolvedValue(Buffer.from(codeDocument));

            const slice = await reader.read("acme/orion-core:jobs/nightly.py", { startLine: 4, endLine: 4 });

            expect(slice.content).toContain("Source lines 4–4 of 5");
            expect(slice.content).toContain("4 | def run():");
            expect(slice.content).not.toContain("1 | import os");
            expect(slice.content).toContain("1 more line(s)");
            expect(slice.content).toContain("startLine=5");
        });

        it("returns prose as written, with its headings as known names", async () => {
            s3.getObject.mockResolvedValue(Buffer.from(proseDocument));

            const slice = await reader.read("orion/google-docs/00-overview.md");

            expect(slice.content).toBe(proseDocument);
            expect(slice.path).toBeUndefined();
            expect(slice.identifiers).toEqual(expect.arrayContaining(["Overview", "Document set"]));
        });

        it("retries with .md appended for a source file that is itself Markdown", async () => {
            s3.getObject
                .mockRejectedValueOnce(notFound("orion/bitbucket/orion-core/README.md"))
                .mockResolvedValueOnce(Buffer.from("# orion-core/README.md\n\n## Content\n\nHello\n"));

            const slice = await reader.read("acme/orion-core:README.md");

            expect(s3.getObject).toHaveBeenNthCalledWith(1, "orion/bitbucket/orion-core/README.md");
            expect(s3.getObject).toHaveBeenNthCalledWith(2, "orion/bitbucket/orion-core/README.md.md");
            expect(slice.content).toContain("Hello");
        });

        it("caps a long document at the read limit and says what remains", async () => {
            const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`);
            s3.getObject.mockResolvedValue(Buffer.from(lines.join("\n")));

            const slice = await reader.read("orion/google-docs/long.md");

            expect(slice.content.length).toBeLessThan(MAX_READ_CHARS + 200);
            expect(slice.content).toMatch(/^\(Lines 1–\d+ of 1000\.\)/);
            expect(slice.content).toMatch(/more line\(s\); call read_document again with startLine=\d+/);
        });

        it("names a missing document plainly", async () => {
            s3.getObject.mockRejectedValue(notFound("orion/google-docs/missing.md"));

            await expect(reader.read("orion/google-docs/missing.md")).rejects.toThrow(
                'There is no document at "orion/google-docs/missing.md"',
            );
        });

        it("treats AccessDenied like a missing key, since S3 answers 403 when ListBucket is not granted", async () => {
            const denied = new Error("Failed to get s3://kb-bucket/onboarding/orion/google-docs/x.md: AccessDenied");
            s3.getObject.mockRejectedValue(denied);

            const failure = await reader.read("orion/google-docs/x.md").catch((err: Error) => err);

            expect((failure as Error).message).toContain('There is no document at "orion/google-docs/x.md"');
            expect((failure as Error).message).not.toContain("kb-bucket");
            expect((failure as Error).message).not.toContain("AccessDenied");
        });

        it("recognises the SDK's own shape of a denied read, whose message never says AccessDenied", async () => {
            s3.getObject.mockRejectedValue(
                new S3ObjectError(
                    "Failed to get s3://kb-bucket/onboarding/orion/google-docs/x.md: Access Denied",
                    "AccessDenied",
                    403,
                ),
            );

            await expect(reader.read("orion/google-docs/x.md")).rejects.toThrow(
                'There is no document at "orion/google-docs/x.md"',
            );
        });

        it("recognises the SDK's own shape of a missing key", async () => {
            s3.getObject.mockRejectedValue(
                new S3ObjectError(
                    "Failed to get s3://kb-bucket/onboarding/orion/google-docs/x.md: The specified key does not exist.",
                    "NoSuchKey",
                    404,
                ),
            );

            await expect(reader.read("orion/google-docs/x.md")).rejects.toThrow(
                'There is no document at "orion/google-docs/x.md"',
            );
        });

        it("retries <path>.md.md for a Markdown source file when the first key is denied", async () => {
            s3.getObject.mockImplementation(async (key: string) => {
                if (key.endsWith(".md.md")) return Buffer.from(proseDocument);
                throw new Error("Failed to get s3://kb-bucket/onboarding/x: AccessDenied");
            });

            const slice = await reader.read("acme/orion-core:docs/guide.md");

            expect(s3.getObject).toHaveBeenCalledWith("orion/bitbucket/orion-core/docs/guide.md");
            expect(s3.getObject).toHaveBeenCalledWith("orion/bitbucket/orion-core/docs/guide.md.md");
            expect(slice.content).toContain("First line.");
        });

        it("keeps the bucket and key of an unexpected S3 failure out of what the agent is told", async () => {
            s3.getObject.mockRejectedValue(new Error("Failed to get s3://kb-bucket/onboarding/k: SlowDown"));

            const failure = await reader.read("orion/google-docs/x.md").catch((err: Error) => err);

            expect((failure as Error).message).not.toContain("kb-bucket");
            expect((failure as Error).message).toContain("could not be read");
        });

        it("numbers the lines of a source file whose name starts with an underscore", async () => {
            s3.getObject.mockResolvedValue(Buffer.from(codeDocument));

            const slice = await reader.read("acme/orion-core:pkg/__init__.py");

            expect(slice.path).toBe("pkg/__init__.py");
            expect(slice.content).toContain("Source lines 1");
        });

        it("still treats the pipeline's repository index document as prose", async () => {
            s3.getObject.mockResolvedValue(Buffer.from(proseDocument));

            const slice = await reader.read("acme/orion-core:_repository");

            expect(slice.path).toBeUndefined();
        });
    });
});
