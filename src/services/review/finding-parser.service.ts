import { getLogger } from "log4js";
import { Service } from "typedi";
import { DiffLine, FileDiff, parseDiff } from "../../utils/diff-line-mapper";

const logger = getLogger("FindingParser");

export type Severity = "critical" | "major" | "minor" | "nit";

export interface Finding {
    status?: string;
    severity: Severity;
    file: string;
    line: number;
    title: string;
    description: string;
    recommendation?: string;
    /** Pre-formatted comment body ready to post to GitHub. If set, use this directly. */
    body?: string;
}

export interface AuditResult {
    summary: string;
    verdict: string;
    findings: Finding[];
    invalidated: string[];
    rawMarkdown: string;
}

@Service()
export class FindingParser {
    /**
     * Parse JSON findings from the extraction LLM call.
     * The JSON contains { file, code, severity, title, body } per finding.
     * We resolve `code` to a line number by searching the diff.
     */
    public parseJsonFindings(rawJson: string, rawAudit: string, diff: string): AuditResult {
        const diffData = parseDiff(diff);
        const findings: Finding[] = [];

        // Find the LAST JSON array in the response.
        // Models may output reasoning/explanation before the JSON.
        const parsed = this.extractLastJsonArray(rawJson);

        if (!parsed) {
            logger.error("Could not find JSON array in LLM response, falling back to regex parser");
            logger.debug(`Response (last 500 chars): ${rawJson.slice(-500)}`);
            return this.parseAuditOutput(rawAudit, diff);
        }

        for (const item of parsed) {
            if (!item.file || !item.code) continue;

            // Strip leading + prefix if present (some models include the diff prefix)
            let code = item.code;
            if (code.startsWith("+")) {
                code = code.slice(1);
            }

            // Find the exact line in the diff
            const line = this.findCodeInDiff(code, item.file, diffData);
            if (!line) {
                logger.warn(`  Could not find "${code.slice(0, 40)}..." in diff for ${item.file}`);
                continue;
            }

            findings.push({
                severity: item.severity || "minor",
                file: item.file,
                line,
                title: item.title || item.code.slice(0, 80),
                description: item.body || item.title || "",
                body: item.body || undefined, // LLM's pre-formatted comment, post as-is
            });
        }

        // Extract verdict from raw audit
        let verdict = "unknown";
        if (/reject|block|do not merge|request.changes/i.test(rawAudit)) verdict = "request_changes";
        else if (/approve|lgtm|looks good/i.test(rawAudit)) verdict = "approve";

        return {
            summary: "",
            verdict,
            findings,
            invalidated: [],
            rawMarkdown: rawAudit,
        };
    }

    /**
     * Find the last valid JSON array in the response text.
     * Models may output reasoning before the JSON — we always take the last array.
     */
    private extractLastJsonArray(text: string): any[] | null {
        // First try: entire response is valid JSON
        const stripped = text
            .replace(/^```(?:json)?\s*\n?/m, "")
            .replace(/\n?```\s*$/m, "")
            .trim();
        try {
            const parsed = JSON.parse(stripped);
            if (Array.isArray(parsed)) return parsed;
        } catch {
            // Not pure JSON, search for arrays in the text
        }

        // Find all [ ... ] blocks, take the last one that parses as valid JSON
        let lastValid: any[] | null = null;
        let searchFrom = 0;

        while (true) {
            const start = text.indexOf("[", searchFrom);
            if (start === -1) break;

            // Find the matching closing bracket
            let depth = 0;
            let end = -1;
            for (let i = start; i < text.length; i++) {
                if (text[i] === "[") depth++;
                else if (text[i] === "]") {
                    depth--;
                    if (depth === 0) {
                        end = i;
                        break;
                    }
                }
            }

            if (end === -1) break;

            const candidate = text.slice(start, end + 1);
            try {
                const parsed = JSON.parse(candidate);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].file) {
                    lastValid = parsed;
                }
            } catch {
                // Not valid JSON, continue searching
            }

            searchFrom = end + 1;
        }

        return lastValid;
    }

    /**
     * Parse reviewer output into findings, using the diff to resolve line numbers.
     */
    public parseReviewerOutput(raw: string, diff: string): Finding[] {
        const diffData = parseDiff(diff);
        return this.extractFindings(raw, diffData);
    }

    /**
     * Parse audit output into structured result, using the diff to resolve line numbers.
     * This is the fallback when JSON extraction fails.
     */
    public parseAuditOutput(raw: string, diff: string): AuditResult {
        const diffData = parseDiff(diff);
        const findings = this.extractFindings(raw, diffData);

        let summary = "";
        const summaryMatch = raw.match(
            /(?:executive summary|summary|conclusion)[:\s]*\n+([\s\S]*?)(?=\n#{1,3}\s|\n\*\*|\n---)/i,
        );
        if (summaryMatch) summary = summaryMatch[1].trim().split("\n\n")[0];

        let verdict = "unknown";
        if (/reject|block|do not merge/i.test(raw)) verdict = "request_changes";
        else if (/approve|lgtm|looks good/i.test(raw)) verdict = "approve";

        const invalidated: string[] = [];
        const invSection = raw.match(/#{1,3}\s*Invalidated[\s\S]*?(?=\n#{1,3}\s|\n---|\$)/i);
        if (invSection) {
            const bullets = invSection[0].match(/[-*]\s+.+/g);
            if (bullets) invalidated.push(...bullets.map((b) => b.replace(/^[-*]\s+/, "")));
        }

        return { summary, verdict, findings, invalidated, rawMarkdown: raw };
    }

    /**
     * Apply second audit corrections.
     */
    public applySecondAuditCorrections(audit: AuditResult, secondAuditOutputs: string[]): AuditResult {
        const findings = [...audit.findings];

        for (const raw of secondAuditOutputs) {
            const incorrectMatches = raw.matchAll(/❌\s*\*\*INCORRECT\*\*[:\s]*(?:\*\*)?(.+?)(?:\*\*)?[\s\n]/gi);
            for (const m of incorrectMatches) {
                const title = m[1].trim();
                const idx = findings.findIndex(
                    (f) =>
                        f.title.toLowerCase().includes(title.toLowerCase()) ||
                        title.toLowerCase().includes(f.title.toLowerCase()),
                );
                if (idx >= 0) findings.splice(idx, 1);
            }
        }

        return { ...audit, findings };
    }

    // -----------------------------------------------------------------------
    // Core: parse structured findings, resolve lines from diff
    //
    // The prompt asks the model to output findings with a **Code** field
    // containing the exact code snippet from the diff. We match that snippet
    // against the diff to find the line number. Fully deterministic.
    // -----------------------------------------------------------------------

    private extractFindings(review: string, diffData: Map<string, FileDiff>): Finding[] {
        // Strategy 1: Parse structured ### blocks with **Code**: field
        const structured = this.parseStructuredFindings(review, diffData);
        if (structured.length > 0) return structured;

        // Strategy 2 (fallback): Scan for code references in free-form text
        return this.parseFreeformFindings(review, diffData);
    }

    /**
     * Parse findings in the structured format our prompt requests:
     * ### <number>
     * - **Severity**: critical
     * - **File**: path/to/file.py
     * - **Code**: `exact code from diff`
     * - **Issue**: description
     * - **Fix**: recommendation
     */
    private parseStructuredFindings(review: string, diffData: Map<string, FileDiff>): Finding[] {
        const findings: Finding[] = [];
        const seen = new Set<string>();

        // Split by ### headings (each is one finding)
        const blocks = review.split(/\n###\s+/).slice(1); // skip content before first ###

        for (const block of blocks) {
            // Skip non-finding headings (Summary, Verdict, Invalidated, etc.)
            if (/^(summary|verdict|invalidated|what both)/i.test(block.trim())) continue;

            const severity = this.parseField(block, "Severity") as Severity;
            const file = this.parseField(block, "File");
            const code = this.parseField(block, "Code");
            const issue = this.parseField(block, "Issue");
            const fix = this.parseField(block, "Fix");
            const status = this.parseField(block, "Status");

            if (!file || !code) continue;

            // Find this exact code in the diff
            const line = this.findCodeInDiff(code, file, diffData);
            if (!line) continue;

            const key = `${file}:${line}`;
            if (seen.has(key)) continue;
            seen.add(key);

            findings.push({
                status: status || undefined,
                severity: severity || "minor",
                file,
                line,
                title: issue?.split(".")[0]?.slice(0, 100) || code.slice(0, 80),
                description: issue || code,
                recommendation: fix || undefined,
            });
        }

        return findings;
    }

    /**
     * Fallback: scan for backtick code references and match against diff.
     */
    private parseFreeformFindings(review: string, diffData: Map<string, FileDiff>): Finding[] {
        const findings: Finding[] = [];
        const seen = new Set<string>();

        // Get all addition lines
        const additionLines: Array<{ file: string; dl: DiffLine }> = [];
        for (const [file, fileDiff] of diffData) {
            for (const dl of fileDiff.lines) {
                if (dl.type === "add" && dl.content.trim()) {
                    additionLines.push({ file, dl });
                }
            }
        }
        if (additionLines.length === 0) return findings;

        // Strip embedded diff/code blocks to avoid matching them
        const clean = review.replace(/```[\s\S]*?```/g, "");

        // Extract backtick code references
        const codeRefs = [...clean.matchAll(/`([^`]{3,})`/g)]
            .map((m) => m[1].trim())
            .filter((c) => !c.includes("/") || c.includes("=") || c.includes("("))
            .filter((c) => !/^[a-zA-Z0-9_.\/\-]+\.[a-z]{1,5}$/.test(c)); // skip file paths

        // For each code ref, find in addition lines
        for (const code of codeRefs) {
            let bestMatch: { file: string; dl: DiffLine } | null = null;
            let bestScore = 0;

            for (const { file, dl } of additionLines) {
                if (dl.content.includes(code) && code.length > bestScore) {
                    bestScore = code.length;
                    bestMatch = { file, dl };
                }
            }

            if (!bestMatch) continue;

            const key = `${bestMatch.file}:${bestMatch.dl.newLineNumber}`;
            if (seen.has(key)) continue;
            seen.add(key);

            findings.push({
                severity: this.findSeverity(review),
                file: bestMatch.file,
                line: bestMatch.dl.newLineNumber,
                title: code.slice(0, 80),
                description: `Code: \`${code}\``,
            });
        }

        return findings;
    }

    /**
     * Parse a field like "- **Severity**: critical" from a block.
     */
    private parseField(block: string, field: string): string | null {
        const regex = new RegExp(`\\*\\*${field}\\*\\*\\s*:\\s*\`?([^\`\\n]+)\`?`, "i");
        const match = block.match(regex);
        if (!match) return null;
        return match[1].trim();
    }

    /**
     * Find exact code snippet in the diff for a given file.
     * Returns the line number of the first addition line that contains the code.
     */
    private findCodeInDiff(code: string, file: string, diffData: Map<string, FileDiff>): number | null {
        // Try exact file match first
        let fileDiff = diffData.get(file);

        // Try partial match (file path might be relative vs full)
        if (!fileDiff) {
            for (const [path, fd] of diffData) {
                if (path.endsWith(file) || file.endsWith(path)) {
                    fileDiff = fd;
                    break;
                }
            }
        }

        if (!fileDiff) return null;

        // Search addition lines first (preferred)
        for (const dl of fileDiff.lines) {
            if (dl.type === "add" && dl.content.includes(code)) {
                return dl.newLineNumber;
            }
        }

        // Fall back to context lines
        for (const dl of fileDiff.lines) {
            if (dl.type === "context" && dl.content.includes(code)) {
                return dl.newLineNumber;
            }
        }

        return null;
    }

    // --- Simple text extractors ---

    private findSeverity(block: string): Severity {
        const lower = block.toLowerCase();
        if (/\bcritical\b/.test(lower)) return "critical";
        if (/\bmajor\b/.test(lower)) return "major";
        if (/\bminor\b/.test(lower)) return "minor";
        if (/\bnit\b/.test(lower)) return "nit";
        return "minor";
    }

    private extractTitle(block: string): string {
        const heading = block.match(/###\s+(.+)/);
        if (heading) return heading[1].replace(/[🔒⚠️🚫💡✅❌🔴]/g, "").trim();

        const bold = block.match(/\*\*(?:\[.*?\])?\s*(.+?)\*\*/);
        if (bold) return bold[1].replace(/[🔒⚠️🚫💡✅❌🔴]/g, "").trim();

        // First sentence
        const firstLine = block.trim().split("\n")[0];
        return firstLine
            .replace(/^[-*#\s]+/, "")
            .replace(/\*\*/g, "")
            .slice(0, 100);
    }

    private extractDescription(block: string): string {
        const issue = block.match(
            /\*\*(?:Issue|Description)\*\*\s*:\s*\n?([\s\S]+?)(?=\n\s*\*\*(?:Risk|Impact|Fix|Recommendation|Line|File)|$)/i,
        );
        if (issue)
            return issue[1]
                .trim()
                .replace(/```[\s\S]*?```/g, "")
                .trim()
                .split("\n\n")[0];

        // Strip metadata, keep substance
        return block
            .replace(/^###\s+.*/m, "")
            .replace(/\*\*File\*\*\s*:.*/gi, "")
            .replace(/\*\*Line\*\*\s*:.*/gi, "")
            .replace(/^\s*[-*]\s+/, "")
            .replace(/\*\*\[.*?\]\*\*\s*/g, "")
            .trim()
            .split("\n\n")[0]
            .slice(0, 500);
    }

    private extractRecommendation(block: string): string | undefined {
        const match = block.match(
            /\*\*(?:Fix Required|Fix|Recommendation|Suggestion|Required next steps)\*\*\s*:\s*([\s\S]+?)(?=\n\s*\*\*|\n\n|$)/i,
        );
        return match ? match[1].trim() : undefined;
    }

    private extractStatus(block: string): string | undefined {
        const match = block.match(/\*\*\[(CONFIRMED|ELEVATED|NEW)\]\*\*/i);
        return match ? match[1] : undefined;
    }

    // --- Formatters ---

    public formatCommentBody(finding: Finding): string {
        // If body is set, it's pre-formatted by the LLM — post it directly, no modification
        if (finding.body) return finding.body;

        // Fallback: build from parts
        const label: Record<Severity, string> = {
            critical: "**Critical:**",
            major: "**Major:**",
            minor: "**Minor:**",
            nit: "**Nit:**",
        };
        const title = finding.title ? ` **${finding.title}**\n\n` : " ";
        const rec = finding.recommendation ? `\n\n**Recommendation:** ${finding.recommendation}` : "";
        return `${label[finding.severity]}${title}${finding.description}${rec}`;
    }

    public formatSummaryTable(audit: AuditResult, prNumber: number): string {
        const { findings, summary, verdict } = audit;
        const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, nit: 0 };
        for (const f of findings) counts[f.severity]++;

        const rows = findings.map(
            (f, i) =>
                `| ${i + 1} | ${f.severity.charAt(0).toUpperCase() + f.severity.slice(1)} | \`${f.file}:${f.line}\` | ${(f.title || f.description).split("\n")[0].slice(0, 100)} |`,
        );

        const emoji = verdict === "approve" ? "✅" : verdict.includes("change") || verdict === "block" ? "🚫" : "⚠️";

        return `## AI Review Summary — PR #${prNumber}

${summary}

**Verdict:** ${emoji} ${verdict.toUpperCase()}

**${counts.critical} critical, ${counts.major} major, ${counts.minor} minor, ${counts.nit} nits** — see inline comments.

| # | Severity | Location | Issue |
|---|----------|----------|-------|
${rows.join("\n")}`;
    }

    public formatAuditMarkdown(audit: AuditResult, prNumber: number): string {
        if (audit.rawMarkdown) return audit.rawMarkdown;

        const sections: string[] = [];
        const emoji = audit.verdict === "approve" ? "✅" : "🚫";
        sections.push(
            `# Audit — PR #${prNumber}\n\n${audit.summary}\n\n**Verdict:** ${emoji} ${audit.verdict.toUpperCase()}`,
        );

        const grouped: Record<Severity, Finding[]> = { critical: [], major: [], minor: [], nit: [] };
        for (const f of audit.findings) grouped[f.severity].push(f);

        for (const [sev, label] of [
            ["critical", "Critical"],
            ["major", "Major"],
            ["minor", "Minor"],
            ["nit", "Nits"],
        ] as const) {
            if (grouped[sev].length > 0) {
                sections.push(
                    `## ${label}\n` +
                        grouped[sev]
                            .map((f) => `- **${f.title}** — \`${f.file}:${f.line}\`\n  ${f.description}\n`)
                            .join("\n"),
                );
            }
        }

        return sections.join("\n\n");
    }
}

const SKIP_IDENTIFIERS = new Set([
    "must_fix",
    "should_fix",
    "could_lead",
    "does_not",
    "must_be",
    "can_be",
    "will_be",
    "has_been",
    "would_be",
    "could_be",
    "might_be",
    "may_be",
    "not_be",
    "line_number",
    "file_path",
    "review_criteria",
]);
