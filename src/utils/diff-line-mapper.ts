/**
 * Resolves the correct line number for a finding by searching the actual diff.
 *
 * The LLM gives us a file path and a description of the issue. We don't trust
 * the line number — instead we search the diff for the code the finding
 * references and return the real new-file line number.
 */

export interface DiffLine {
    newLineNumber: number;
    content: string; // the raw line content (without the +/ /- prefix)
    type: "add" | "context" | "delete";
}

export interface FileDiff {
    file: string;
    lines: DiffLine[];
}

/**
 * Parse a unified diff into structured per-file line data.
 * Each line gets its new-file line number.
 */
export function parseDiff(diff: string): Map<string, FileDiff> {
    const result = new Map<string, FileDiff>();
    const fileSections = diff.split(/^diff --git /m).filter((s) => s.trim());

    for (const section of fileSections) {
        const fileMatch = section.match(/^a\/(.+?)\s+b\/(.+)/m);
        if (!fileMatch) continue;
        const file = fileMatch[2];

        const diffLines: DiffLine[] = [];
        const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@.*$/gm;
        let hunkMatch: RegExpExecArray | null;
        const hunkPositions: Array<{ newStart: number; startIdx: number }> = [];

        while ((hunkMatch = hunkRegex.exec(section)) !== null) {
            hunkPositions.push({
                newStart: parseInt(hunkMatch[1], 10),
                startIdx: hunkMatch.index + hunkMatch[0].length,
            });
        }

        for (let i = 0; i < hunkPositions.length; i++) {
            const hp = hunkPositions[i];
            const endIdx = i + 1 < hunkPositions.length ? hunkPositions[i + 1].startIdx : section.length;
            const hunkBody = section.slice(hp.startIdx, endIdx);
            const lines = hunkBody.split("\n");

            let newLineNum = hp.newStart;

            for (const line of lines) {
                if (line.startsWith("@@") || line.startsWith("diff ")) break;
                if (line.startsWith("\\")) continue; // "\ No newline at end of file"

                if (line.startsWith("-")) {
                    diffLines.push({ newLineNumber: -1, content: line.slice(1), type: "delete" });
                } else if (line.startsWith("+")) {
                    diffLines.push({ newLineNumber: newLineNum, content: line.slice(1), type: "add" });
                    newLineNum++;
                } else if (line.length > 0) {
                    // Context line (starts with space)
                    diffLines.push({ newLineNumber: newLineNum, content: line.startsWith(" ") ? line.slice(1) : line, type: "context" });
                    newLineNum++;
                }
            }
        }

        result.set(file, { file, lines: diffLines });
    }

    return result;
}

/**
 * Find the correct line number for a finding by searching the diff content.
 *
 * Extracts keywords from the finding's title, description, and recommendation,
 * then searches for them in the diff lines of the specified file.
 * Returns the new-file line number of the best matching line.
 *
 * Only matches commentable lines (additions and context lines, not deletions).
 */
export function findLineInDiff(
    diffData: Map<string, FileDiff>,
    file: string,
    finding: { title: string; description: string; recommendation?: string; line?: number },
): number | null {
    const fileDiff = diffData.get(file);
    if (!fileDiff) return null;

    const commentableLines = fileDiff.lines.filter((l) => l.type !== "delete" && l.newLineNumber > 0);
    if (commentableLines.length === 0) return null;

    // Build search terms from the finding
    const searchText = `${finding.title} ${finding.description} ${finding.recommendation || ""}`.toLowerCase();

    // Extract meaningful code identifiers to search for
    const codePatterns = extractCodePatterns(searchText);

    // Score each commentable line
    let bestLine: DiffLine | null = null;
    let bestScore = 0;

    for (const dl of commentableLines) {
        const content = dl.content.toLowerCase().trim();
        if (!content) continue;

        let score = 0;

        // Check each code pattern against this line
        for (const pattern of codePatterns) {
            if (content.includes(pattern)) {
                // Longer matches are worth more
                score += pattern.length;
            }
        }

        // Bonus for addition lines (new code is more likely to have issues)
        if (dl.type === "add" && score > 0) {
            score += 2;
        }

        if (score > bestScore) {
            bestScore = score;
            bestLine = dl;
        }
    }

    // If we found a good match, use it
    if (bestLine && bestScore > 0) {
        return bestLine.newLineNumber;
    }

    // Fallback: if the LLM's line number is a valid commentable line, use it
    if (finding.line) {
        const exactMatch = commentableLines.find((l) => l.newLineNumber === finding.line);
        if (exactMatch) return finding.line;
    }

    // Last resort: return the first addition line in the file's diff
    const firstAdd = commentableLines.find((l) => l.type === "add");
    if (firstAdd) return firstAdd.newLineNumber;

    return commentableLines[0]?.newLineNumber ?? null;
}

/**
 * Extract meaningful code identifiers from finding text.
 * These are variable names, function names, string literals, etc.
 */
function extractCodePatterns(text: string): string[] {
    const patterns: string[] = [];

    // Quoted strings (e.g. "admin", "hubops@secret123")
    const quoted = text.matchAll(/["`']([^"`']{2,})["`']/g);
    for (const m of quoted) patterns.push(m[1].toLowerCase());

    // Backtick code (e.g. `db_password`, `compute_hub_score`)
    const backtick = text.matchAll(/`([^`]{2,})`/g);
    for (const m of backtick) patterns.push(m[1].toLowerCase());

    // Snake_case and camelCase identifiers (variable/function names)
    const identifiers = text.matchAll(/\b([a-z][a-z0-9_]{2,}(?:_[a-z0-9]+)*)\b/g);
    for (const m of identifiers) {
        const id = m[1];
        // Skip common English words
        if (!COMMON_WORDS.has(id) && id.includes("_")) {
            patterns.push(id);
        }
    }

    // camelCase identifiers
    const camel = text.matchAll(/\b([a-z][a-zA-Z0-9]{3,})\b/g);
    for (const m of camel) {
        if (/[A-Z]/.test(m[1]) && !COMMON_WORDS.has(m[1].toLowerCase())) {
            patterns.push(m[1].toLowerCase());
        }
    }

    // Deduplicate and sort by length (longer = more specific = better)
    const unique = [...new Set(patterns)].sort((a, b) => b.length - a.length);
    return unique;
}

const COMMON_WORDS = new Set([
    "the", "and", "for", "that", "this", "with", "from", "not", "are", "but",
    "can", "has", "have", "will", "should", "would", "could", "may", "might",
    "does", "did", "was", "were", "been", "being", "which", "when", "where",
    "what", "how", "why", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "than", "too", "very", "just", "also",
    "into", "over", "after", "before", "between", "under", "about", "above",
    "line", "file", "code", "issue", "error", "function", "method", "class",
    "variable", "parameter", "return", "value", "type", "check", "missing",
    "should", "must", "need", "required", "critical", "major", "minor",
    "security", "performance", "data", "input", "output", "result",
    "description", "recommendation", "title", "severity",
]);
