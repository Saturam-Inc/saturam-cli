/**
 * Markdown (what the mentor agent writes) to Slack mrkdwn (what Slack renders).
 *
 * They look alike and are not: Slack bolds with one asterisk, italicises with underscores, writes
 * links as <url|text>, has no headings or tables, and requires &, < and > escaped everywhere.
 * Sent unconverted, an answer shows literal "**" and "##" and loses every link.
 *
 * Line-oriented rather than a full Markdown parser: agent answers use a small, regular subset,
 * and a converter this size is one a reader can check against Slack's rules in one sitting.
 */

/** Section blocks hold at most 3000 characters; the margin covers re-opening a split code fence. */
export const SECTION_TEXT_LIMIT = 2900;

const BOLD = "\u0000";

export function escapeMrkdwn(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Link text cannot contain "|" or ">" inside Slack's <url|text>. */
function linkText(text: string): string {
    return text.replace(/\|/g, "¦");
}

/** Inline formatting for one run of prose (never inside code). Input is already escaped. */
function convertProse(text: string): string {
    return (
        text
            .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) =>
                alt ? `<${url}|${linkText(alt)}>` : `<${url}>`,
            )
            .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
                /^(https?:|mailto:)/.test(url) ? `<${url}|${linkText(label)}>` : label,
            )
            // Autolinks, which escaping turned into &lt;url&gt;.
            .replace(/&lt;((?:https?:|mailto:)[^\s&]+)&gt;/g, "<$1>")
            .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
            .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${BOLD}$1${BOLD}`)
            // Single-asterisk emphasis is italic in Markdown but bold in Slack.
            .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "_$1_")
            .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
            .replace(new RegExp(BOLD, "g"), "*")
    );
}

/** Inline formatting for a line, leaving `code spans` exactly as written. */
function convertInline(line: string): string {
    return line
        .split(/(`[^`\n]+`)/g)
        .map((segment, index) => (index % 2 === 1 ? escapeMrkdwn(segment) : convertProse(escapeMrkdwn(segment))))
        .join("");
}

function stripEmphasis(text: string): string {
    return text.replace(/\*\*|__/g, "");
}

function convertLine(line: string): string {
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) return heading[1] ? `*${convertInline(stripEmphasis(heading[1]))}*` : "";

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "";

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return `> ${convertInline(quote[1])}`;

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
        const depth = Math.floor(bullet[1].replace(/\t/g, "    ").length / 2);
        return `${"    ".repeat(depth)}• ${convertInline(bullet[2])}`;
    }

    return convertInline(line);
}

function isTableRow(line: string): boolean {
    return /^\s*\|.*\|\s*$/.test(line);
}

function isTableDivider(line: string): boolean {
    return /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line);
}

/**
 * Tables have no Slack equivalent; as a code block their columns still line up, which is the
 * part of a table that carries meaning.
 */
function renderTable(rows: string[]): string[] {
    const cells = rows
        .filter((row) => !isTableDivider(row))
        .map((row) =>
            row
                .trim()
                .replace(/^\||\|$/g, "")
                .split("|")
                .map((cell) => stripEmphasis(cell.trim())),
        );
    const widths = cells.reduce<number[]>((acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)), []);
    return [
        "```",
        ...cells.map((row) =>
            escapeMrkdwn(
                row
                    .map((cell, i) => cell.padEnd(widths[i]))
                    .join("  ")
                    .trimEnd(),
            ),
        ),
        "```",
    ];
}

export function markdownToMrkdwn(markdown: string): string {
    const out: string[] = [];
    let inFence = false;
    let table: string[] = [];

    const flushTable = () => {
        if (table.length > 0) out.push(...renderTable(table));
        table = [];
    };

    for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
        if (/^\s*```/.test(line)) {
            flushTable();
            inFence = !inFence;
            // Slack ignores a language tag and would print it as the first line of code.
            out.push("```");
            continue;
        }
        if (inFence) {
            out.push(escapeMrkdwn(line));
            continue;
        }
        if (isTableRow(line)) {
            table.push(line);
            continue;
        }
        flushTable();
        out.push(convertLine(line));
    }
    flushTable();
    if (inFence) out.push("```");

    return out
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function countFences(text: string): number {
    return (text.match(/^```/gm) ?? []).length;
}

/**
 * Splits mrkdwn into section-sized pieces, preferring paragraph then line boundaries. A code
 * block cut in two is closed at the end of one piece and re-opened at the start of the next, so
 * each renders on its own.
 */
export function splitMrkdwn(text: string, limit: number = SECTION_TEXT_LIMIT): string[] {
    const pieces: string[] = [];
    let current = "";

    const push = () => {
        if (current.trim()) pieces.push(current.trim());
        current = "";
    };

    const units = text.split(/(\n\n)/).flatMap((unit) => (unit.length > limit ? unit.split(/(\n)/) : [unit]));
    for (const unit of units) {
        if (current.length + unit.length <= limit) {
            current += unit;
            continue;
        }
        push();
        // A single line longer than a whole section: cut it hard.
        for (let start = 0; start < unit.length; start += limit) {
            const slice = unit.slice(start, start + limit);
            if (slice.length === limit) pieces.push(slice);
            else current = slice;
        }
    }
    push();

    let openFence = false;
    return pieces.map((piece) => {
        const reopened = openFence ? `\`\`\`\n${piece}` : piece;
        openFence = countFences(reopened) % 2 === 1;
        return openFence ? `${reopened}\n\`\`\`` : reopened;
    });
}
