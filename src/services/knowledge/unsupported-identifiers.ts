/**
 * Finds identifiers an answer used that appear nowhere in its sources.
 *
 * This is the string-checkable core of what a post-answer audit was trying to do with a model:
 * the invention that actually hurts a reader is a file, path, script, table or setting they will
 * go looking for and not find. Whether a name is present in the retrieved text is a substring
 * question, not a judgement — so it is answered here without a model, and without the false
 * positives a model produced on exactly this task.
 *
 * Deliberately conservative. A miss costs one unflagged invention; a false positive costs a
 * revision call and risks a correct answer being rewritten. So only tokens that look like code
 * are checked, anything with a wildcard or placeholder is skipped, and a path counts as supported
 * if its last segment appears anywhere in the sources — the writer often composes a full path
 * from a directory the sources name and a file they name separately.
 */

const BACKTICKED = /`([^`\n]{3,120})`/g;
const PATH_LIKE = /(?:[\w.-]+\/)+[\w.-]+/g;

/**
 * A bare filename is only recognisable by its extension, and the set of extensions that matter
 * depends entirely on what the project is written in. A fixed list would quietly favour whichever
 * stack it was drawn from — a Terraform or Scala codebase would have its filenames go unchecked
 * while a Python one did not.
 *
 * So the set is assembled per call: a base of extensions common across stacks, plus every
 * extension the retrieved documents themselves use. A corpus that talks about `.tf` files teaches
 * this check what a `.tf` file is, without anyone adding it to a list.
 */
const BASE_EXTENSIONS = [
    // code
    "py",
    "js",
    "ts",
    "tsx",
    "jsx",
    "java",
    "kt",
    "scala",
    "go",
    "rb",
    "rs",
    "php",
    "cs",
    "cpp",
    "c",
    "h",
    "swift",
    "sh",
    "bash",
    "ps1",
    "sql",
    "r",
    "pl",
    "lua",
    "dart",
    "ex",
    "clj",
    "groovy",
    // config and infrastructure
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "tf",
    "tfvars",
    "gradle",
    "xml",
    "dockerfile",
    "lock",
    // markup, docs, data
    "md",
    "rst",
    "txt",
    "html",
    "css",
    "scss",
    "csv",
    "tsv",
    "parquet",
    "avro",
    "proto",
    "ipynb",
    "pkl",
];

/** Extensions the documents themselves use, so the check calibrates to the project's own stack. */
function extensionsIn(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(/\.([a-z][a-z0-9]{0,7})\b/g)) found.add(match[1]);
    return [...found];
}

function fileLikePattern(extensions: Iterable<string>): RegExp {
    const alternation = [...new Set(extensions)]
        .filter((extension) => /^[a-z][a-z0-9]{0,7}$/.test(extension))
        .sort((a, b) => b.length - a.length)
        .join("|");
    return new RegExp(`\\b[\\w-]+\\.(?:${alternation})\\b`, "g");
}

/** Looks like an identifier rather than a word: has a separator, a digit, or CamelCase. */
const LOOKS_LIKE_CODE = /[/._\-\d]|[a-z][A-Z]/;

/** Wildcards, placeholders and templating — never literal names, so never checkable. */
const NOT_LITERAL = /[*<>{}|$?]|\.\.\./;

const MIN_LENGTH = 4;

export function extractIdentifiers(answer: string, knownExtensions: Iterable<string> = BASE_EXTENSIONS): string[] {
    const found = new Set<string>();
    const fileLike = fileLikePattern([...BASE_EXTENSIONS, ...knownExtensions]);

    // Backticked spans first. A single code-looking token counts; a command, a phrase, or anything
    // with a wildcard or placeholder does not — and is blanked out so the path and file patterns
    // below cannot pull a fragment back out of it ("x.py" out of "${HOME}/x.py"). URLs go too.
    let remaining = answer.replace(/https?:\/\/\S+/g, " ");
    for (const match of remaining.matchAll(BACKTICKED)) {
        const token = match[1].trim();
        if (!/\s/.test(token) && !NOT_LITERAL.test(token)) found.add(token);
    }
    remaining = remaining.replace(BACKTICKED, (span: string, inner: string) =>
        /\s/.test(inner) || NOT_LITERAL.test(inner) ? " ".repeat(span.length) : span,
    );

    for (const match of remaining.matchAll(PATH_LIKE)) found.add(match[0]);
    for (const match of remaining.matchAll(fileLike)) found.add(match[0]);

    const cleaned = [...found]
        .map((token) => token.replace(/^[("'`]+|[.,;:!?)"'`]+$/g, ""))
        .filter((token) => token.length >= MIN_LENGTH)
        .filter((token) => LOOKS_LIKE_CODE.test(token))
        .filter((token) => !NOT_LITERAL.test(token))
        .filter((token) => !/^\d+(\.\d+)*$/.test(token));

    // "app/config.py" and "config.py" are one identifier, not two: keep the fuller form.
    const basenamesOfPaths = new Set(cleaned.filter((t) => t.includes("/")).map((t) => t.split("/").pop()));
    return [...new Set(cleaned.filter((t) => t.includes("/") || !basenamesOfPaths.has(t)))];
}

/**
 * Identifiers from the answer that neither the sources nor the earlier conversation contain.
 * Earlier answers count as support: a fact established two turns ago is not an invention now.
 */
export function findUnsupportedIdentifiers(answer: string, sources: string, priorAnswers: string[] = []): string[] {
    const supporting = [sources, ...priorAnswers].join("\n");
    const haystack = supporting.toLowerCase();
    if (!haystack.trim()) return [];

    return extractIdentifiers(answer, extensionsIn(haystack)).filter((identifier) => {
        const lower = identifier.toLowerCase();
        if (haystack.includes(lower)) return false;
        const basename = lower.split("/").pop() ?? lower;
        return !haystack.includes(basename);
    });
}
