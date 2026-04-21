import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export type ReviewerApproach = "architecture" | "data-flow";

export const REVIEWER_APPROACHES: Record<ReviewerApproach, string> = {
    architecture: "Focus on architectural correctness, API contracts, SQL logic, and security.",
    "data-flow": "Focus on data flow, state management, edge cases, and performance.",
};

/**
 * Prompt for an independent code reviewer (Phase 1).
 * Two reviewers run in parallel with different approaches to reduce bias.
 */
export function getReviewerMessages(params: {
    prNumber: number;
    prTitle: string;
    prBody: string;
    diff: string;
    ticketContext?: string;
    approach: ReviewerApproach;
}): { system: SystemMessage; user: HumanMessage } {
    const system = new SystemMessage(
        `You are a senior code reviewer performing a thorough review of pull request #${params.prNumber}.

## Review Criteria (check all thoroughly)

1. **Project patterns** — Does the code follow existing codebase conventions? Check naming, file structure, imports, component patterns, query patterns.
2. **Type safety** — Any \`any\` types, missing types, type assertions without justification, unsafe casts? Schema type mismatches?
3. **Edge cases** — Missing null checks, empty state handling, error boundaries, loading states?
4. **Gaps vs requirements** — Does the implementation fully cover what the ticket requires? Any missing features?
5. **Security** — SQL injection risks, XSS, improper auth checks, data exposure?
6. **Performance** — N+1 queries, missing indexes, unnecessary re-renders, large bundle impacts, missing pagination, unbounded fetches?
7. **SQL correctness** — Query logic, joins, filters, aggregations, sort correctness (client-side vs server-side on paginated data)?
8. **Data flow** — State management correctness, race conditions, stale closures, merge semantics?

## Approach
${REVIEWER_APPROACHES[params.approach]}

## Output Format

Return a structured review in EXACTLY this format:

## Summary
<2-3 sentence executive summary>

## Findings

### <finding number>
- **Severity**: <critical|major|minor|nit>
- **File**: <exact file path from diff>
- **Code**: \`<exact code snippet from the diff that has the issue — copy it verbatim>\`
- **Issue**: <what's wrong>
- **Fix**: <what it should be instead>

### <next finding>
...

## Verdict
<approve|request_changes|block> — <rationale>

IMPORTANT:
- The **Code** field must contain the EXACT code as it appears in the diff (copy-paste from the + lines). This is used to locate the comment position.
- One finding per issue. Do not combine multiple issues into one finding.
- Return ONLY the markdown review with no preamble.`,
    );

    const ticket = params.ticketContext
        ? `## Ticket Context\n${params.ticketContext}\n`
        : `## Ticket Context\nNo ticket context provided — review the diff on its own merits.\n`;

    const user = new HumanMessage(`## Pull Request
**Title:** ${params.prTitle}
**Description:** ${params.prBody || "No description provided."}

${ticket}
## Diff
\`\`\`diff
${params.diff}
\`\`\`

Now produce your review.`);

    return { system, user };
}

/**
 * Prompt for the audit pass (Phase 2).
 * Cross-validates the two reviews against the actual diff.
 */
export function getAuditMessages(params: {
    prNumber: number;
    prTitle: string;
    reviewA: string;
    reviewB: string;
    diff: string;
}): { system: SystemMessage; user: HumanMessage } {
    const system = new SystemMessage(
        `You are a senior auditor cross-validating two independent code reviews.

## Audit Instructions

For each finding from either review, classify as:
- **CONFIRMED** — both agree OR you verified against the code
- **INVALIDATED** — incorrect or misunderstood (explain why)
- **ELEVATED** — one reviewer found it, you verified it's real

Then identify anything **both reviewers missed**.

## Output Format

Return your audit in EXACTLY this format:

## Summary
<2-3 sentence summary of the PR quality>

## Findings

### <number>
- **Status**: <CONFIRMED|ELEVATED|NEW>
- **Severity**: <critical|major|minor|nit>
- **File**: <exact file path from diff>
- **Code**: \`<exact code snippet from the diff that has the issue — copy it verbatim from the + lines>\`
- **Issue**: <what's wrong>
- **Fix**: <what it should be instead>

### <next finding>
...

## Invalidated
- <finding title> — <reason it's wrong>

## Verdict
<approve|request_changes|block> — <rationale>

IMPORTANT:
- The **Code** field must contain the EXACT code as it appears in the diff (copy-paste from the + lines). This is used to locate the comment position.
- Only include findings you have verified against the actual diff. Do not include invalidated findings in the Findings section.
- One finding per issue. Do not combine multiple issues into one finding.
- Return ONLY the markdown audit with no preamble.`,
    );

    const user = new HumanMessage(`## PR #${params.prNumber}: ${params.prTitle}

## Reviewer A (Architecture focus)
${params.reviewA}

---

## Reviewer B (Data-flow focus)
${params.reviewB}

---

## Diff
\`\`\`diff
${params.diff}
\`\`\`

Produce your audit.`);

    return { system, user };
}

/**
 * Prompt for the second-round audit (Phase 3, large PRs only).
 * Two subagents independently verify each finding in the round-1 audit.
 */
export function getSecondAuditMessages(params: { prNumber: number; audit: string; diff: string }): {
    system: SystemMessage;
    user: HumanMessage;
} {
    const system = new SystemMessage(
        `You are a second-round auditor verifying the accuracy of a first-round audit.

## Task

For each finding in the audit:
- ✅ **VERIFIED** — confirmed against the code
- ❌ **INCORRECT** — wrong, explain why with diff line references
- ⚠️ **NUANCED** — partially correct, needs clarification

Also check if the audit missed anything significant.

Keep it concise — focus on verification, not re-reviewing. Return ONLY the markdown verification.`,
    );

    const user = new HumanMessage(`## First Audit (PR #${params.prNumber})
${params.audit}

---

## Diff
\`\`\`diff
${params.diff}
\`\`\`

Verify each finding.`);

    return { system, user };
}

/**
 * Prompt to extract structured JSON from the raw audit for posting to GitHub.
 * This is the final step — takes the human-readable audit and converts it to
 * machine-readable JSON with exact code snippets for line resolution.
 */
export function getExtractFindingsMessages(params: { audit: string; diff: string }): {
    system: SystemMessage;
    user: HumanMessage;
} {
    const system = new SystemMessage(
        `You are a JSON extraction tool. You take a code review and a diff, and return ONLY a JSON array. No explanation, no markdown, no text before or after — just the JSON array.

Each object in the array represents one inline comment to post on GitHub:
- "file": exact file path from the diff
- "code": the EXACT line from the diff (verbatim from a + line) that the comment should be placed on
- "severity": "critical" | "major" | "minor" | "nit"
- "title": short title (under 80 chars)
- "body": full markdown comment body with issue description and fix

IMPORTANT: Return ONLY the JSON array. No other text.

## Example

Given this diff:
\`\`\`diff
diff --git a/src/auth.py b/src/auth.py
@@ -10,3 +10,8 @@ def login():
     return redirect("/home")
+
+def get_user_token():
+    secret_key = "sk-hardcoded-abc123"
+    token = jwt.encode({"user": "admin"}, secret_key)
+    return token
\`\`\`

And this audit:
"Critical: Hardcoded secret key in get_user_token. The JWT signing key is committed to source control."

The correct output is:
[{"file":"src/auth.py","code":"    secret_key = \\"sk-hardcoded-abc123\\"","severity":"critical","title":"Hardcoded JWT secret key","body":"**Critical:** Hardcoded JWT secret key\\n\\nThe signing key \`sk-hardcoded-abc123\` is committed to source control. Anyone with repo access can forge tokens.\\n\\n**Fix:** Load from environment:\\n\`\`\`python\\nsecret_key = os.environ[\\"JWT_SECRET_KEY\\"]\\n\`\`\`"}]

## Another Example

Given this diff:
\`\`\`diff
diff --git a/src/utils.ts b/src/utils.ts
@@ -5,3 +5,7 @@ export function parse(input: string) {
     return JSON.parse(input);
+
+export function fetchData(url: string) {
+    const res = await fetch(url);
+    return res.json();
+}
\`\`\`

And this audit:
"Major: fetchData is not async but uses await. Minor: No error handling for failed fetch."

The correct output is:
[{"file":"src/utils.ts","code":"    const res = await fetch(url);","severity":"major","title":"Missing async keyword","body":"**Major:** \`fetchData\` uses \`await\` but is not declared as \`async\`\\n\\nThis will throw a SyntaxError at runtime.\\n\\n**Fix:**\\n\`\`\`typescript\\nexport async function fetchData(url: string) {\\n\`\`\`"},{"file":"src/utils.ts","code":"    return res.json();","severity":"minor","title":"No error handling for fetch","body":"**Minor:** No error handling for failed HTTP requests\\n\\nIf the fetch fails or returns non-2xx, \`res.json()\` may throw or return unexpected data.\\n\\n**Fix:** Check \`res.ok\` before parsing:\\n\`\`\`typescript\\nif (!res.ok) throw new Error(\`Fetch failed: \${res.status}\`);\\nreturn res.json();\\n\`\`\`"}]

Now do the same for the following audit and diff. Return ONLY the JSON array.`,
    );

    const user = new HumanMessage(`## Audit
${params.audit}

## Diff
\`\`\`diff
${params.diff}
\`\`\``);

    return { system, user };
}
