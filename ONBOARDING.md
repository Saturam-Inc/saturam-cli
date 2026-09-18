# Project Onboarding Integrations Overview

This document summarizes the onboarding integrations, sample responses, normalization logic, configuration, and commands available in the CLI.

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

## 2. Reusable Knowledge Adapters & Normalization Pipelines

Raw payloads are converted into standard Markdown or structured JSON via adapters implementing the `KnowledgeSource` model:

### Knowledge Source Adapters ([src/services/knowledge/](src/services/knowledge/))

- **`ConfluenceKnowledgeSource`**: Syncs Confluence page storage format into Markdown using HTML normalizers.
- **`JiraKnowledgeSource`**: Syncs Jira issues and their comments into Markdown using ADF normalizers.
- **`GoogleDriveKnowledgeSource`**: Syncs Google Docs and Drive binary files into Markdown/raw formats.

### Normalizer Services ([src/services/normalizers/](src/services/normalizers/))

- **ADF to Markdown ([adf-normalizer.service.ts](src/services/normalizers/adf-normalizer.service.ts))**: Converts Jira JSON-based Atlassian Document Format (ADF) nodes recursively into clean Markdown text (bold, lists, blockquotes, mentions, etc.).
- **HTML/XHTML to Markdown ([html-normalizer.service.ts](src/services/normalizers/html-normalizer.service.ts))**: Parses Confluence storage XHTML and Mammoth HTML strings into clean Markdown blocks, standardizing headers, bullet points, user references, and tables.
- **Google Sheets to JSON**: Fetches rows and cells and saves them as a structured, queryable JSON sidecar list.
- **Word Documents (.docx)**: Downloads raw access bytes, extracts HTML locally via `mammoth.js`, and normalizes it into Markdown via `HtmlNormalizerService`.

---

## 3. Orchestration & Configuration

### Orchestrator ([onboard.service.ts](src/services/onboarding/onboard.service.ts))

The orchestrator reads project configuration lists, triggers parallel fetch requests, resolves URLs found in Google Sheets, and routes tasks to the appropriate knowledge adapters.

### Google Sheets URL Resolution & Project Tab Mapping

When syncing via Google Sheets, the orchestrator:

1. **Scans Cells for Document Links**: Cells are recursively searched for Confluence pages, Jira tickets, Google Docs, and nested Google Sheets.
2. **Dynamic Tab Discovery**: If `range` is omitted in the configuration, all sheet tabs are automatically discovered and processed in an optimized batch network call.
3. **Tab-to-Project name mapping**: Tab titles (e.g. `ProjectA`, `ProjectB`) are treated as project folder names, syncing their resolved documents under corresponding directories (e.g. `onboarding/projecta/confluence/...`).
4. **Nested Sheets Sync**: Extracted Google Sheet links inside spreadsheet cells are processed recursively as sub-sheet tasks, saving their raw data as JSON sidecar structures.

### Project-Level Configuration (`.sateng/onboarding.json`)

To synchronize project onboarding documents locally, create a `.sateng/onboarding.json` file in your repository root with the following structure:

```json
{
    "_comment": "This is a configuration template for project onboarding. Replace placeholders with actual values.",
    "confluence": {
        "baseUrl": "https://your-domain.atlassian.net"
    },
    "jira": {
        "baseUrl": "https://your-domain.atlassian.net"
    },
    "projects": {
        "ExampleProject": {
            "confluence": {
                "pages": ["123456789"],
                "space": "PROJ"
            },
            "jira": {
                "tickets": ["PROJ-123"]
            },
            "googleDocs": {
                "docs": ["your-google-doc-id-here"]
            },
            "googleSheets": {
                "spreadsheetId": "your-google-sheet-id-here",
                "range": "Sheet1!A1:E100"
            },
            "onboardingSheets": [
                {
                    "spreadsheetId": "your-onboarding-links-sheet-id-here"
                }
            ]
        }
    }
}
```

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

### Sync Onboarding Content (Dual-Mode)

#### Mode A: Sync from Local Configuration

Fetch and synchronize documents based on the `.sateng/onboarding.json` targets:

```bash
npx ts-node src/entrypoints/main.ts onboard
```

#### Generating a Sample Config

If you don't have a `.sateng/onboarding.json` yet, generate one with example Confluence, Jira, and Google Drive (Docs/Sheets) entries:

```bash
sat-cli onboard --format
```

This writes the template to `.sateng/onboarding.json` at the repository root. If that file already exists, it writes to `.sateng/onboarding.sample.json` instead so your existing config is never overwritten. Edit the generated file with your real page IDs, ticket keys, and document IDs, then run `sat-cli onboard` to sync.

#### Mode B: Sync Directly from a Google Sheet

Fetch and synchronize documents directly from a Google Sheet URL or spreadsheet ID without needing local config files:

```bash
npx ts-node src/entrypoints/main.ts onboard <spreadsheet_url_or_id>
```

`sat-cli onboard` reads the first tab of the sheet and picks one of two modes based on its header row:

- **Structured project sheet** — if the header row contains a `project_name` column, the sheet is parsed directly into the same shape as `.sateng/onboarding.json` (one row per project). See [`onboarding-sheet-template.csv`](onboarding-sheet-template.csv) for the full column reference — import it into Google Sheets (File → Import) as a starting point, or copy its header row into a new sheet. Multi-value columns (`confluence_pages`, `jira_tickets`, `google_docs`, `onboarding_sheet_ids`) are comma-separated within a cell. The resolved config is also written to `.sateng/onboarding.json` at the repository root before syncing (tagged with a `_sourceGoogleSheetId` field, for reference only — it's not what drives re-checking, see below).

    **Re-checking the sheet on later runs**: the sheet's ID is remembered in your personal config (`~/.config/sateng/config.json`, alongside your Google access token), not in the local `.sateng/onboarding.json` file. That means plain `sat-cli onboard` (no argument) — **run from any directory** — automatically re-fetches that same sheet and overwrites `.sateng/onboarding.json` at the repository root each time, so editing values in the sheet and just running `sat-cli onboard` again always picks up the latest columns. Passing an explicit config file path (`sat-cli onboard path/to/config.json`) always bypasses this and loads that file directly instead.

- **Sheet of links** (legacy) — if there's no `project_name` column, every cell is scanned for Confluence/Jira/Google Doc/Sheet URLs instead, with each sheet tab treated as its own project (see [Google Sheets URL Resolution & Project Tab Mapping](#google-sheets-url-resolution--project-tab-mapping) above).

#### Syncing a Single Project

By default, `sat-cli onboard` syncs every source in `.sateng/onboarding.json` — global (non-project) entries and every `projects.*` section. Pass `--project-name <name>` to restrict the run to just the matching `projects.<name>` section (matched case/punctuation-insensitively against the config key):

```bash
sat-cli onboard --project-name "SMILE"
sat-cli onboard --project-name "SMILE" --upload-to-s3
```

This resolves and fetches only that project's Confluence pages/spaces, Jira tickets/JQL, Google Docs, Google Sheets, and onboarding-sheet-resolved links — skipping every other project and any global (non-project) config entries. Output folders are named after `<project-name>` (e.g. `onboarding/smile/confluence/...`), and (with `--upload-to-s3`) only that project's files are uploaded. If no project matches, the command warns and lists the available project names from your config.

For the Google Sheet direct-sync mode (`sat-cli onboard <spreadsheet_url_or_id>`), `--project-name` restricts the run to just the matching project: the `project_name` row for a structured project sheet, or the sheet tab whose title matches in sheet-of-links mode.

#### Uploading to S3

Pass `--upload-to-s3` to upload every file written during the run to the configured S3 bucket (see [Cloud (AWS S3 & Bedrock Knowledge Base)](README.md#cloud-aws-s3--bedrock-knowledge-base) in the README for how to configure S3 via `sat-cli init`):

```bash
sat-cli onboard --project-name "Saturam Core" --upload-to-s3
```

For each content file, this:

1. Ensures the destination "folder" prefix exists in the bucket (creates it if not — S3 has no real folders, so this is a marker object under that prefix).
2. Checks whether the content object already exists at that key in S3.
3. If not, uploads the content **plus a Bedrock Knowledge Base-compliant metadata sidecar** at `<key>.metadata.json` — e.g. alongside `saturam-core/google-docs/golden-record.md`, it writes `saturam-core/google-docs/golden-record.md.metadata.json` containing:

    ```json
    {
        "metadataAttributes": {
            "title": "...",
            "source": "google-docs",
            "url": "...",
            "category": "google-docs",
            "project": "saturam-core",
            "updatedAt": "...",
            "author": "..."
        }
    }
    ```

    Already-present content is left untouched and reported as skipped.

This naming — `<content-key>.metadata.json` in the same prefix as the content object — is the exact convention Amazon Bedrock Knowledge Bases uses to attach filterable metadata to a source document during ingestion. It is **not** the same as the local `<file>.json` bookkeeping sidecar written by `sat-cli onboard` (which stores full document metadata for `--list` and isn't uploaded to S3 under its own name) — uploading that bare `.json` next to the content would make Bedrock ingest it as its own separate document instead of recognizing it as metadata.

Local content files always mirror their path under `~/.config/sateng/onboarding/` as the S3 key (e.g. `saturam-core/google-docs/golden-record.md`), optionally under the bucket's configured prefix. Once synced, point a Bedrock Knowledge Base's S3 data source at that bucket/prefix and run an ingestion job (`StartIngestionJob`, or via the console) to chunk, embed, and index the content — the `metadataAttributes` become filterable at query time (e.g. retrieve only chunks where `project = saturam-core`).

#### Listing Synced Documents

`--list` reads what's already synced locally (no network calls) and prints it grouped by project name and source category:

```bash
sat-cli onboard --list
```

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

Each question passes through five agents, wired by `AnswerFlowService`:

| Agent                   | Role                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Intent classifier       | General question, project question, or a question about the corpus itself                                 |
| Project router          | Resolves which project the question is about, or decides it is ambiguous                                  |
| General technical agent | Answers general questions with no retrieval, marking what is industry practice rather than our convention |
| Mentor answerer         | Produces the grounded answer for project questions                                                        |
| Follow-up generator     | Suggests three or four next questions the Knowledge Base can actually answer                              |

**Intent classification.** A follow-up is deliberately _not_ its own intent. "And how does it fail?" is still a project question — what makes it a follow-up is that its subject comes from the previous turn, which the classifier resolves into a standalone question before routing.

**Project routing.** Resolution is cheapest-first: a project named in the question, then the project you have been discussing, then a broad unfiltered retrieval whose results are grouped by their `project` metadata. The last step grounds routing in what is actually indexed rather than in the model guessing from a name. You are asked to choose only when no single project dominates:

```
? "How do refunds work?" could mean a few things — which one?
  > SMILE · Customer-facing refunds portal (12 matches)
    Billing Core · Payment capture and settlement (9 matches)
    Ask across all projects
    Let me rephrase
```

In non-interactive runs (`--ci`, or piped stdin) no picker can be shown, so the top-ranked project is used and the assumption is stated.

**The answer contract.** Every project answer follows the same skeleton, dropping any part the retrieved context cannot support rather than padding it: what the answer is, why the thing exists, how it works, where it lives, and what to watch out for.

**Follow-ups.** Suggestions are constrained to material the Knowledge Base holds — a suggestion it cannot answer wastes a turn. Select one to continue, or choose "Ask my own question".

##### Conversation memory

History is what makes follow-ups work. Each turn stores the question, the answer, a one-line gist, and the resolved project. Agents receive the last three turns as attributed messages plus a rolling digest of everything older, rather than the full transcript — a mentor-length answer runs 400–600 tokens, so replaying twenty of them would make classification the most expensive call in the flow.

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
