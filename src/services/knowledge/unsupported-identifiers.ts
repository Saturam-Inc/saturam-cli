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
const FILE_LIKE = /\b[\w-]+\.(?:py|sh|js|ts|md|json|cfg|ini|sql|html|yaml|yml|txt|csv|pkl|toml|env)\b/g;

/** Looks like an identifier rather than a word: has a separator, a digit, or CamelCase. */
const LOOKS_LIKE_CODE = /[/._\-\d]|[a-z][A-Z]/;

/** Wildcards, placeholders and templating — never literal names, so never checkable. */
const NOT_LITERAL = /[*<>{}|$?]|\.\.\./;

const MIN_LENGTH = 4;

export function extractIdentifiers(answer: string): string[] {
    const found = new Set<string>();

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
    for (const match of remaining.matchAll(FILE_LIKE)) found.add(match[0]);

    const cleaned = [...found]
        .map((token) => token.replace(/^[("'`]+|[.,;:!?)"'`]+$/g, ""))
        .filter((token) => token.length >= MIN_LENGTH)
        .filter((token) => LOOKS_LIKE_CODE.test(token))
        .filter((token) => !NOT_LITERAL.test(token))
        .filter((token) => !/^\d+(\.\d+)*$/.test(token));

    // "kpi/config.py" and "config.py" are one identifier, not two: keep the fuller form.
    const basenamesOfPaths = new Set(cleaned.filter((t) => t.includes("/")).map((t) => t.split("/").pop()));
    return [...new Set(cleaned.filter((t) => t.includes("/") || !basenamesOfPaths.has(t)))];
}

/**
 * Identifiers from the answer that neither the sources nor the earlier conversation contain.
 * Earlier answers count as support: a fact established two turns ago is not an invention now.
 */
export function findUnsupportedIdentifiers(answer: string, sources: string, priorAnswers: string[] = []): string[] {
    const haystack = [sources, ...priorAnswers].join("\n").toLowerCase();
    if (!haystack.trim()) return [];

    return extractIdentifiers(answer).filter((identifier) => {
        const lower = identifier.toLowerCase();
        if (haystack.includes(lower)) return false;
        const basename = lower.split("/").pop() ?? lower;
        return !haystack.includes(basename);
    });
}
