/**
 * Removes inline citation markers like "[1]" or "[1, 2]" from an answer.
 *
 * Citations are indistinguishable from array indices (`x[1]`) and list literals (`[1, 2, 3]`)
 * by shape alone, and mentor answers routinely contain code examples. So the answer is split
 * into code and prose segments and only prose is stripped, with a further guard that a marker
 * directly attached to an identifier is an index, never a citation.
 */
export function stripInlineCitations(answer: string): string {
    // Odd-indexed segments are the captured code spans (fenced blocks or inline code).
    return answer
        .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
        .map((segment, index) =>
            index % 2 === 1
                ? segment
                : // The lookbehind sits at the bracket, not before the whitespace: a citation
                  // is separated from the preceding word ("applies [1]"), while an index is
                  // attached to it ("x[1]", "fn()[1]").
                  segment.replace(/\s*(?<![\w\])])\[\d+(?:\s*,\s*\d+)*\]/g, ""),
        )
        .join("");
}
