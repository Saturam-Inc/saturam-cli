import { readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative } from "path";

/**
 * Guards the whole of `src/` against one client's vocabulary, not just the prompt text.
 *
 * A sibling test renders every prompt and checks the result. That catches a client name in a
 * prompt string but not one in a doc comment, a constant, or an example inside a regex — and
 * those found their way in anyway: a file-extension list drawn from one project's stack, a
 * comment naming another's directory, a doc comment quoting a third's schedule. None of them
 * changed behaviour, and all of them told the next reader this tool was built for one client.
 *
 * The CLI is one binary serving every deployment. A term here ships to all of them.
 */
const SOURCE_ROOT = join(__dirname, "..", "src");

/**
 * Terms belonging to a specific client rather than to the product. Add to this list whenever a
 * new client's jargon appears; the test is the reason it will not stay.
 *
 * Generic technology names are deliberately absent — the CLI legitimately speaks about Confluence,
 * Jira, Bedrock and S3 because it integrates with them. What is banned is the vocabulary of the
 * systems we are asked *about*.
 */
const CLIENT_TERMS: Array<{ label: string; pattern: RegExp }> = [
    { label: "MRF", pattern: /\bMRF\b/ },
    { label: "SMILE", pattern: /\bSMILE\b/ },
    { label: "ARAP", pattern: /\bARAP\b/ },
    { label: "Qualdo", pattern: /\bQualdo\b/ },
    { label: "DE Framework", pattern: /DE Framework/ },
    { label: "Airflow", pattern: /\bAirflow\b/i },
    { label: "DAG", pattern: /\bDAGs?\b/ },
    { label: "Azure Data Factory", pattern: /Azure Data Factory/i },
    { label: "spend domain", pattern: /spend domains?/i },
    { label: "a client's shell scripts", pattern: /\b(?:cons|spare|should_cost|service)\.sh\b/ },
    { label: "a client's scheduler modules", pattern: /\b(?:airflow|table)_scheduler(?:\.py)?\b/ },
    { label: "a client's kpi directory", pattern: /\bkpi\// },
    { label: "pkl_path", pattern: /\bpkl_path\b/ },
];

function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return extname(full) === ".ts" ? [full] : [];
    });
}

describe("no client vocabulary anywhere in src/", () => {
    const files = sourceFiles(SOURCE_ROOT);

    it("finds source files to check", () => {
        expect(files.length).toBeGreaterThan(30);
    });

    it.each(CLIENT_TERMS)("$label", ({ pattern }) => {
        const offenders = files
            .map((file) => ({ file: relative(SOURCE_ROOT, file), text: readFileSync(file, "utf8") }))
            .flatMap(({ file, text }) =>
                text
                    .split("\n")
                    .map((line, index) => ({ file, line: index + 1, content: line }))
                    .filter(({ content }) => pattern.test(content)),
            )
            .map(({ file, line, content }) => `${file}:${line}  ${content.trim().slice(0, 100)}`);

        expect(offenders).toEqual([]);
    });
});
