# Project Onboarding Integrations Overview

This document covers how onboarding documentation is queried from the CLI, and how the corpus it
queries is produced.

> **Ingestion moved out of the CLI.** Fetching Confluence pages, Jira tickets and Google Drive
> files, normalizing them to Markdown, and uploading them to S3 for Bedrock to ingest now runs as
> a scheduled AWS Lambda off a Google Sheet — see the `on-boarding` service in
> `sat-cli-internal-infra` (`README.md`, `DEPLOY.md`, and `SHEET-COLUMNS.md` for the sheet
> format). `sat-cli onboard` no longer syncs anything; it is now purely the query side.

---

## 1. Active Integration Services

Each integration service wraps target REST APIs and handles authorization internally.

### Confluence ([confluence.service.ts](src/integrations/confluence/services/confluence.service.ts))

- **`getPage(baseUrl, pageId)`**
    - _Sample Response:_ `{ id: "12345", title: "Page Name", body: { storage: { value: "<p>HTML...</p>" } }, version: { number: 1 }, space: { key: "DS" } }`
- **`getPageMetadata(baseUrl, pageId)`**
    - _Sample Response:_ `{ id: "12345", title: "Page Name", version: { number: 1 }, space: { key: "DS" } }`
- **`listChildPages(baseUrl, pageId)`**
    - _Sample Response:_ `{ results: [{ id: "67890", title: "Child Page Title", type: "page" }] }`
- **`listSpaces(baseUrl)`**
    - _Sample Response:_ `{ results: [{ id: 111, key: "DS", name: "Data Science Space", type: "global" }] }`
- **`listPagesInSpace(baseUrl, spaceKey)`**
    - _Sample Response:_ `{ results: [{ id: "12345", title: "Page Name", type: "page" }] }`
- **`searchContent(baseUrl, cql)`**
    - _Sample Response:_ `{ results: [{ id: "12345", title: "Page Name", type: "page" }] }`

### Jira ([jira.service.ts](src/integrations/jira/services/jira.service.ts))

- **`getIssue(baseUrl, issueKey)`**
    - _Sample Response:_ `{ id: "1000", key: "DS-1", fields: { summary: "Issue summary", status: { name: "To Do" }, description: { type: "doc", content: [...] }, comment: { comments: [...] } } }`
- **`getIssueMetadata(baseUrl, issueKey)`**
    - _Sample Response:_ `{ id: "1000", key: "DS-1", fields: { summary: "Issue summary", status: { name: "To Do" } } }`
- **`searchIssues(baseUrl, jql)`**
    - _Sample Response:_ `{ issues: [{ id: "1000", key: "DS-1", fields: { ... } }] }`
- **`searchIssueKeys(baseUrl, jql)`**
    - _Sample Response:_ `["DS-1", "DS-2"]`
- **`listProjects(baseUrl)`**
    - _Sample Response:_ `[{ id: "10010", key: "DS", name: "Data Science" }]`
- **`listBoards(baseUrl)`**
    - _Sample Response:_ `{ values: [{ id: 1, name: "DS Board", type: "scrum" }] }`
- **`getBoardBacklogIssues(baseUrl, boardId)`**
    - _Sample Response:_ `{ issues: [{ key: "DS-5", fields: { summary: "Backlog ticket" } }] }`
- **`listChildIssues(baseUrl, parentKey)`**
    - _Sample Response:_ `{ issues: [{ key: "DS-10", fields: { summary: "Child subtask" } }] }`

### Google Drive ([google-drive.service.ts](src/integrations/google-drive/services/google-drive.service.ts))

- **`getFileMetadata(fileId)`**
    - _Sample Response:_ `{ id: "file-id", name: "Doc Name", mimeType: "application/vnd.google-apps.document", owners: [...] }`
- **`getFileBinary(fileId)`**
    - _Sample Response:_ `ArrayBuffer` (Raw file bytes representation)
- **`listFilesInFolder(folderId)`**
    - _Sample Response:_ `{ files: [{ id: "file-id", name: "File Name", mimeType: "text/plain" }] }`
- **`searchFiles(query)`**
    - _Sample Response:_ `{ files: [{ id: "file-id", name: "Matched File" }] }`
- **`getGoogleDoc(documentId)`**
    - _Sample Response:_ `{ documentId: "doc-id", title: "Document Title", body: { content: [...] } }`
- **`exportGoogleDocAsMarkdown(documentId)`**
    - _Sample Response:_ `"Raw markdown text formatted string"`
- **`exportGoogleDocAsHtml(documentId)`**
    - _Sample Response:_ `"Raw HTML string representation of the document"`
- **`getSpreadsheetMetadata(spreadsheetId)`**
    - _Sample Response:_ `{ spreadsheetId: "sheet-id", title: "Spreadsheet Title", spreadsheetUrl: "https://...", owners: [...], modifiedTime: "...", createdTime: "...", sheets: [{ sheetId: 0, title: "Sheet1", index: 0 }] }`
- **`getSpreadsheetData(spreadsheetId)`**
    - _Sample Response:_ `{ spreadsheetId: "sheet-id", valueRanges: [{ range: "Sheet1!A1:Z100", values: [["header1", "header2"], ["val1", "val2"]] }] }`
- **`batchGetSpreadsheetValues(spreadsheetId, ranges)`**
    - _Sample Response:_ `{ valueRanges: [{ range: "Sheet1!A:E", values: [["header1"], ["row1"]] }] }`

---

## 2. Normalization

Raw payloads are converted to Markdown before they are indexed, but that happens in the
`on-boarding` Lambda (`sat-cli-internal-infra/on-boarding/src/normalize/`), not in this repo: Jira
ADF, Confluence storage-format XHTML and Word documents (via `mammoth`) are all normalized there.
The API clients above return raw responses and do no conversion of their own.

---

## 3. Where the Corpus Comes From

The CLI reads an already-indexed corpus; it does not build one. Ingestion — resolving each
project's Confluence pages, Jira tickets and Google Drive files from a Google Sheet, normalizing
them, writing them to S3 under `<project>/<category>/`, and emitting the `registry.json` the CLI's
project routing reads — runs in the `on-boarding` Lambda in `sat-cli-internal-infra`.

Two things that pipeline produces are contracts this repo depends on:

- **`<content-key>.metadata.json`** beside each content object, holding `metadataAttributes`
  (`title`, `source`, `url`, `category`, `project`, `updatedAt`, `author`). Bedrock turns these
  into query-time filters, which is what `--knowledge-base --project` and the agent's
  project-scoped searches use, and what supplies the source URLs printed under a `--chat` answer.
- **`registry.json`** under the S3 _state_ prefix (a sibling of the content prefix, so Bedrock
  never ingests it as a document), listing the indexed projects. `ProjectRegistryService` reads it
  to know which projects exist — Bedrock can filter on a `project` value but cannot enumerate the
  values present.

### Personal Configuration (`config.json`)

The CLI stores user-level integration credentials (API tokens and Google OAuth tokens) inside a single personal config file at `~/.config/sateng/config.json`. These credentials can be configured using `sat-cli init` or overridden using environment variables.

---

## 4. Run Commands

### Initialize Setup

Setup your integration credentials interactively:

```bash
npx ts-node src/entrypoints/main.ts init
```

This lets you configure AI providers, SCM platforms, Atlassian integrations, and Google Drive integrations at the top level.

### Querying the Knowledge Base

Both modes read the corpus the Lambda indexed; neither fetches from Confluence, Jira or Drive.

#### Testing Bedrock Knowledge Base Retrieval

Use the AWS credentials and Bedrock Knowledge Base configured by `sat-cli init` to run the equivalent of the AWS console's **Standard retrieval only** mode directly in the terminal:

```bash
sat-cli onboard --knowledge-base
sat-cli onboard --knowledge-base --project "Saturam"
```

Enter questions interactively to see ranked matching chunks with their relevance scores, source locations, and metadata. This command calls Bedrock's `Retrieve` API and does not generate an AI answer. Enter a blank question, type `exit`, `quit`, or `:q`, or press Ctrl+C to stop.

#### Asking questions (`--chat`)

`--knowledge-base` shows you the raw retrieved chunks. `--chat` answers the question the way a senior engineer would explain it to someone who just joined:

```bash
sat-cli onboard --chat
sat-cli onboard --chat --new-session
```

There is no `--project` flag here — the project is determined per question. `--project` still applies to `--knowledge-base`, which is a raw retrieval tool.

##### The answering flow

Each question goes to one mentor agent (`MentorAgentService`), wired by `AnswerFlowService`. There is no fixed classify → route → retrieve → write pipeline: the agent is given three tools and decides which a question needs.

| Tool                   | What the agent uses it for                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `search_documentation` | Retrieves passages, broadly or narrowed to one project; called again with different wording when results miss |
| `list_projects`        | Says what is indexed, and the exact slug for a project the user named                                         |
| `recall_conversation`  | Reaches turns older than the verbatim window, including ones from earlier sessions                            |

The agent searches until it can answer, within six tool rounds. A model without tool calling gets one search on the question and a single prompt instead.

**Project attribution.** The project shown above an answer is read off the retrieved chunks' `project` metadata, not decided before searching. When the chunks come from more than one project, the answer is shown without a project label. You are never asked to choose a project.

**Checks on the answer.** Two guards run in code on whatever the model wrote. Any file, path, script or table the answer names that appears in neither the sources nor the recent conversation triggers one revision, and anything shaped like a credential is redacted.

**Follow-ups.** Suggestions are constrained to material the Knowledge Base holds — a suggestion it cannot answer wastes a turn. Select one to continue, or choose "Ask my own question".

##### Conversation memory

History is what makes follow-ups work. Each turn stores the question, the answer, a one-line gist, and the resolved project. Agents receive the last three turns as attributed messages plus a rolling digest of everything older, rather than the full transcript — a mentor-length answer runs 400–600 tokens, so replaying twenty of them would dominate every prompt.

By default history lives in memory and lasts only for the session. Configure a `conversationTable` under your AWS cloud config to persist it in DynamoDB, which is what lets a later run continue the same conversation:

```json
{
    "cloud": {
        "aws": {
            "conversationTable": { "tableName": "sateng-conversations", "ttlDays": 90 }
        }
    }
}
```

The table needs partition key `pk` (string) and sort key `sk` (string), with TTL enabled on `expiresAt`. Persistence failures degrade to a warning — losing history makes answers less contextual but never takes down the flow. Use `--new-session` to start fresh.

Same exit controls as `--knowledge-base`: blank input, `exit`, `quit`, `:q`, or Ctrl+C.

##### Evaluating answer quality

Prompt changes are checked against a scored eval set rather than by eye:

```bash
pnpm test:eval
```

This runs real questions through the flow and grades each answer with an LLM judge against the answer contract — does it answer the literal question, explain why, define its jargon, point somewhere specific, avoid inventing, and read as one explanation. It makes real API calls and is excluded from `pnpm test`. The fixtures in `tests/eval/fixtures/mentor-questions.json` are placeholders: replace them with real questions about projects in your own Knowledge Base before reading anything into the scores.

---

## 5. Troubleshooting & Expiration Notes

### Google OAuth Token Expiration

If you configured your Google Drive integration using a temporary access token from the Google OAuth Playground, please note that **these tokens expire in approximately 1 hour**.

Once the token expires, the CLI will output `401 Unauthorized` errors when fetching Google Docs or Sheets. To resolve this:

1. Re-generate a new access token from the Google OAuth Playground.
2. Run `sat-cli init` (or `npx ts-node src/entrypoints/main.ts init`) to update the token in your personal configuration.
