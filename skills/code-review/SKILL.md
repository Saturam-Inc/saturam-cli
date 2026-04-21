---
name: code-review
description: "Rigorous multi-model code review. Runs two independent reviews (Claude subagents), then an audit that validates/invalidates findings and catches what both missed. Optional second audit for large PRs. Posts inline comments on specific lines."
argument-hint: ["<pr-number> [--repo owner/repo]"]
integrations: [github]
---

# Code Review

Two independent reviewers, then an audit. Three perspectives, no bias. Inline comments on specific lines.

## Tools

Everything runs inside Claude Code using the built-in `Agent` tool for parallel subagents. No external tools (cmux, Cursor Agent) required.

- **Orchestrator**: The main Claude Code conversation — coordinates phases, reads the diff, writes reviews if subagents are blocked, posts comments.
- **Subagents**: Claude Code `Agent` tool with `run_in_background: true` — reviewers, auditor, second-round auditors.

## Inputs

| Input          | Required | Description                                                                            |
| -------------- | -------- | -------------------------------------------------------------------------------------- |
| PR number      | Yes      | The PR to review (number or URL)                                                       |
| Repo           | No       | `owner/repo` — inferred from cwd if omitted                                            |
| Ticket context | No       | Ticket number, description, or requirements. Can be provided inline or as a file path. |

No mandatory context files. The diff is the primary input. Ticket context improves the review but isn't blocking.

## Review Artifacts

All artifacts are written to `.context/reviews/` (already gitignored) and cleaned up after posting:

- `.context/reviews/pr<number>-xhigh.review.md` — Reviewer A findings
- `.context/reviews/pr<number>-omax.review.md` — Reviewer B findings
- `.context/reviews/pr<number>-audit.review.md` — Consolidated audit
- `.context/reviews/pr<number>-audit-2a.review.md`, `.context/reviews/pr<number>-audit-2b.review.md` — Second audit round (large PRs only)

Create the directory at the start of the review: `mkdir -p .context/reviews`

## Workflow

### Phase 0 — Gather context

1. Get the PR metadata:
    ```bash
    gh pr view <number> --repo <owner/repo> --json headRefName,headRefOid,title,body,additions,deletions,changedFiles
    ```
2. Save the full diff to a temp file (subagents read from disk):
    ```bash
    gh pr diff <number> --repo <owner/repo> > /tmp/pr<number>-diff.txt
    ```
3. Note the PR size — file count, additions, deletions. This determines whether Phase 3 runs.
4. If ticket context was provided, include it in the review prompts.

### Phase 1 — Dual Independent Review

Launch **2 subagents in parallel** using the Agent tool with `run_in_background: true`. Each writes to a separate file. Neither reads the other's output.

**Subagent A** → `.context/reviews/pr<number>-xhigh.review.md`
**Subagent B** → `.context/reviews/pr<number>-omax.review.md`

Each subagent receives the same prompt (see Review Prompt Template below) but is told to approach from a different angle:

- Subagent A: Focus on architectural correctness, API contracts, SQL logic, and security.
- Subagent B: Focus on data flow, state management, edge cases, and performance.

**Permission fallback**: If subagents are denied Read/Bash permissions, the orchestrator must read the diff itself and write both review files directly. This is the expected fallback — do not retry subagents indefinitely.

Wait for both subagents to complete before proceeding.

### Phase 2 — Audit (round 1)

Launch **1 subagent** that reads both reviews + the diff. It:

- Validates/invalidates each finding against the actual code
- Catches what both reviewers missed
- Writes to `.context/reviews/pr<number>-audit.review.md`

See Audit Prompt Template below.

### Phase 3 — Second Audit (large PRs only)

**Trigger when**: diff >500 lines, >10 files, spans multiple subsystems, or explicitly requested.

Launch **2 subagents in parallel**, each independently verifying the round-1 audit:

- Subagent 2A → `.context/reviews/pr<number>-audit-2a.review.md`
- Subagent 2B → `.context/reviews/pr<number>-audit-2b.review.md`

Each reads the audit + diff and marks each finding as:

- ✅ VERIFIED
- ❌ INCORRECT (with explanation)
- ⚠️ NUANCED (partially correct, needs clarification)

The orchestrator incorporates their feedback into the final `.context/reviews/pr<number>-audit.review.md`.

### Phase 4 — Surface review for approval

Present the audit to the user **before posting anything to GitHub**. The user may want to adjust findings, remove false positives, or change severity levels before the review goes out.

1. Show the user the summary table and each inline comment that will be posted.
2. Ask: "Ready to post this review, or do you want to adjust anything?"
3. Only proceed to Phase 5 after the user confirms.

If running autonomously (no user in the loop), skip to Phase 5 directly.

### Phase 5 — Post Inline Comments

Post **every** finding as an inline comment on the exact file and line, with a summary table as the review body.

**Deriving line numbers** — no git fetch or clone needed:

- For **new files** (`status: added`): the line number in the file is the line number in the diff.
- For **modified files**: use the line number in the **new version** of the file (the `+` side of the hunk). The hunk header `@@ -old_start,old_count +new_start,new_count @@` gives you the starting line — count forward through context and `+` lines to find your target.

**Two-step API call** (body + comments can't be reliably sent together in a single `gh api` call):

1. Create a pending review with inline comments (omit `event` to keep it pending):

    ```bash
    gh api repos/<owner>/<repo>/pulls/<number>/reviews \
      --method POST \
      --field commit_id=<head_sha> \
      --input <(python3 -c "
    import json
    comments = [
        {'path': 'path/to/file.ts', 'line': 42, 'side': 'RIGHT', 'body': '**Critical**: ...'},
        {'path': 'path/to/other.ts', 'line': 17, 'side': 'RIGHT', 'body': '**Major**: ...'},
    ]
    print(json.dumps({'comments': comments}))
    ")
    ```

    Save the returned `id` from the response.

2. Submit the review with the summary body:

    ```bash
    gh api repos/<owner>/<repo>/pulls/<number>/reviews/<review_id>/events \
      --method POST \
      --field event=COMMENT \
      --field body="$(cat <<'EOF'
    ## QC Review Summary — PR #<number>

    **X critical, Y major, Z minor, W nits** — see inline comments.

    | # | Severity | Location | Issue |
    |---|----------|----------|-------|
    | 1 | Critical | `file.ts:42` | One-line description |
    | 2 | Major | `other.ts:17` | One-line description |
    ...
    EOF
    )"
    ```

**Rules for inline comments:**

- Post **all** findings as inline comments — critical, major, minor, and nits. Every finding belongs on the line it references.
- Each comment is self-contained — reader shouldn't need to see other comments to understand.
- Prefix with bold severity: `**Critical:**`, `**Major:**`, `**Minor:**`, `**Nit:**`.
- Include the fix recommendation, not just the problem.
- The summary body is a **table** listing every finding with severity, location, and a one-line description. End with a short "what's solid" line acknowledging what the PR does well.

### Phase 6 — Clean up

```bash
rm -rf .context/reviews/ /tmp/pr<number>-diff.txt /tmp/pr-review-payload.json
```

## Review Prompt Template

Adapt to the specific PR. Include ticket context if available.

```
You are a senior code reviewer performing a thorough review of PR #<number> in <repo>.

## Task
1. Read the full diff at /tmp/pr<number>-diff.txt (read in chunks if needed)
2. Explore the codebase at <repo-path> for existing patterns and conventions
3. Write a thorough review to <repo-path>/<output-file>

## Ticket Context
<ticket description or "No ticket context provided — review the diff on its own merits.">

## Review Criteria

Check all of the following thoroughly:

1. **Project patterns** — Does the code follow existing codebase conventions? Check naming, file structure, imports, component patterns, query patterns.
2. **Type safety** — Any `any` types, missing types, type assertions without justification, unsafe casts? Schema/pgtyped type mismatches?
3. **Edge cases** — Missing null checks, empty state handling, error boundaries, loading states?
4. **Gaps vs requirements** — Does the implementation fully cover what the ticket requires? Any missing features?
5. **Security** — SQL injection risks, XSS, improper auth checks, data exposure?
6. **Performance** — N+1 queries, missing indexes, unnecessary re-renders, large bundle impacts, missing pagination, unbounded fetches?
7. **SQL correctness** — Query logic, joins, filters, aggregations, sort correctness (client-side vs server-side on paginated data)?
8. **Data flow** — State management correctness, race conditions, stale closures, merge semantics?

## Approach
<"Focus on architectural correctness, API contracts, SQL logic, and security." OR "Focus on data flow, state management, edge cases, and performance.">

## Output Format

Write as structured markdown with:
- Executive summary (2-3 sentences)
- Sections for each review criteria with specific findings
- For each finding: file path, line number, severity (critical/major/minor/nit), description, recommendation
- Final verdict section

Be specific. Reference exact files and lines. Don't be vague — show what it should be instead.
```

## Audit Prompt Template

```
You are a senior auditor cross-validating two independent code reviews of PR #<number>.

## Task
1. Read both reviews:
   - <repo-path>/.context/reviews/pr<number>-xhigh.review.md
   - <repo-path>/.context/reviews/pr<number>-omax.review.md
2. Read the full diff at /tmp/pr<number>-diff.txt
3. Cross-validate findings, identify what both missed
4. Write your audit to <repo-path>/.context/reviews/pr<number>-audit.review.md

## Audit Instructions

For each finding from either review:
- **CONFIRMED** — both agree or you verified against the code
- **INVALIDATED** — incorrect or misunderstood (explain why)
- **ELEVATED** — one reviewer found it, you verified it's real

Then identify anything **both reviewers missed**.

## Output Format

# Audit Review — PR #<number>: <title>

## Critical Findings (must fix before merge)
- **[CONFIRMED/ELEVATED]** Title — severity, file:line, explanation

## Major Findings (should fix before merge)
Same format

## Minor/Nits (fix at your discretion)
Same format

## What Both Reviewers Missed
Any new findings

## Summary Verdict
Overall recommendation with rationale
```

## Second Audit Prompt Template

```
You are a second-round auditor verifying the accuracy of the first audit of PR #<number>.

## Task
1. Read the first audit at <repo-path>/.context/reviews/pr<number>-audit.review.md
2. Read the relevant portions of the diff at /tmp/pr<number>-diff.txt to verify each finding
3. For each finding, mark as:
   - ✅ VERIFIED — confirmed against the code
   - ❌ INCORRECT — wrong, explain why with diff line references
   - ⚠️ NUANCED — partially correct, needs clarification
4. Check if the audit missed anything significant
5. Write results to <repo-path>/<output-file>

Keep it concise — focus on verification, not re-reviewing.
```
