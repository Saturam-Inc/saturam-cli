# Project Onboarding Integrations Overview

This document summarizes the onboarding integrations, sample responses, normalization logic, configuration, and commands available in the CLI.

---

## 1. Active Integration Services

Each integration service wraps target REST APIs and handles authorization internally.

### Confluence (`ConfluenceService`)
* **`getPage(baseUrl, pageId)`**
  * *Sample Response:* `{ id: "12345", title: "Page Name", body: { storage: { value: "<p>HTML...</p>" } }, version: { number: 1 }, space: { key: "DS" } }`
* **`getPageMetadata(baseUrl, pageId)`**
  * *Sample Response:* `{ id: "12345", title: "Page Name", version: { number: 1 }, space: { key: "DS" } }`
* **`listChildPages(baseUrl, pageId)`**
  * *Sample Response:* `{ results: [{ id: "67890", title: "Child Page Title", type: "page" }] }`
* **`listSpaces(baseUrl)`**
  * *Sample Response:* `{ results: [{ id: 111, key: "DS", name: "Data Science Space", type: "global" }] }`
* **`listPagesInSpace(baseUrl, spaceKey)`**
  * *Sample Response:* `{ results: [{ id: "12345", title: "Page Name", type: "page" }] }`
* **`searchContent(baseUrl, cql)`**
  * *Sample Response:* `{ results: [{ id: "12345", title: "Page Name", type: "page" }] }`

### Jira (`JiraService`)
* **`getIssue(baseUrl, issueKey)`**
  * *Sample Response:* `{ id: "1000", key: "DS-1", fields: { summary: "Issue summary", status: { name: "To Do" }, description: { type: "doc", content: [...] }, comment: { comments: [...] } } }`
* **`getIssueMetadata(baseUrl, issueKey)`**
  * *Sample Response:* `{ id: "1000", key: "DS-1", fields: { summary: "Issue summary", status: { name: "To Do" } } }`
* **`searchIssues(baseUrl, jql)`**
  * *Sample Response:* `{ issues: [{ id: "1000", key: "DS-1", fields: { ... } }] }`
* **`searchIssueKeys(baseUrl, jql)`**
  * *Sample Response:* `["DS-1", "DS-2"]`
* **`listProjects(baseUrl)`**
  * *Sample Response:* `[{ id: "10010", key: "DS", name: "Data Science" }]`
* **`listBoards(baseUrl)`**
  * *Sample Response:* `{ values: [{ id: 1, name: "DS Board", type: "scrum" }] }`
* **`getBoardBacklogIssues(baseUrl, boardId)`**
  * *Sample Response:* `{ issues: [{ key: "DS-5", fields: { summary: "Backlog ticket" } }] }`
* **`listChildIssues(baseUrl, parentKey)`**
  * *Sample Response:* `{ issues: [{ key: "DS-10", fields: { summary: "Child subtask" } }] }`

### Google Drive (`GoogleDriveService`)
* **`getFileMetadata(fileId)`**
  * *Sample Response:* `{ id: "file-id", name: "Doc Name", mimeType: "application/vnd.google-apps.document", owners: [...] }`
* **`getFileBinary(fileId)`**
  * *Sample Response:* `ArrayBuffer` (Raw file bytes representation)
* **`listFilesInFolder(folderId)`**
  * *Sample Response:* `{ files: [{ id: "file-id", name: "File Name", mimeType: "text/plain" }] }`
* **`searchFiles(query)`**
  * *Sample Response:* `{ files: [{ id: "file-id", name: "Matched File" }] }`
* **`getGoogleDoc(documentId)`**
  * *Sample Response:* `{ documentId: "doc-id", title: "Document Title", body: { content: [...] } }`
* **`exportGoogleDocAsMarkdown(documentId)`**
  * *Sample Response:* `"Raw markdown text formatted string"`
* **`exportGoogleDocAsHtml(documentId)`**
  * *Sample Response:* `"Raw HTML string representation of the document"`
* **`getSpreadsheetMetadata(spreadsheetId)`**
  * *Sample Response:* `{ spreadsheetId: "sheet-id", properties: { title: "Title" }, sheets: [{ properties: { title: "Sheet1" } }] }`
* **`getSpreadsheetData(spreadsheetId)`**
  * *Sample Response:* `{ spreadsheetId: "sheet-id", valueRanges: [{ range: "Sheet1!A1:Z100", values: [["header1", "header2"], ["val1", "val2"]] }] }`
* **`batchGetSpreadsheetValues(spreadsheetId, ranges)`**
  * *Sample Response:* `{ valueRanges: [{ range: "Sheet1!A:E", values: [["header1"], ["row1"]] }] }`

---

## 2. Normalization Pipelines

Raw payloads are converted into standard Markdown or structured JSON:
* **ADF to Markdown (`AdfNormalizerService`):** Converts Jira JSON-based Atlassian Document Format (ADF) nodes recursively into clean Markdown text (bold, lists, blockquotes, mentions, etc.).
* **HTML/XHTML to Markdown (`HtmlNormalizerService`):** Parses Confluence storage XHTML and Mammoth HTML strings into clean Markdown blocks, standardizing headers, bullet points, user references, and tables.
* **Google Sheets to JSON:** Fetches rows and cells and saves them as a structured, queryable JSON sidecar list.
* **Word Documents (.docx):** Downloads raw access bytes, extracts HTML locally via `mammoth.js`, and normalizes it into Markdown via `HtmlNormalizerService`.

---

## 3. Orchestration & Configuration

### Orchestrator (`OnboardService`)
The [onboard.service.ts] serves as the main pipeline executor. It reads the project onboarding config template, triggers parallel fetch requests, routes documents through the correct normalizers, and writes the output files locally.

### Config file (`config.json`)
The CLI stores user-level credentials (API tokens and Google OAuth tokens) inside a single personal config file at `~/.config/sateng/config.json`. These credentials can also be overridden by exporting environment variables (`ATLASSIAN_EMAIL`, `ATLASSIAN_TOKEN`, `GOOGLE_ACCESS_TOKEN`).

---

## 4. Run Commands

### Initialize Setup
Setup your integration credentials:
```bash
npx ts-node src/entrypoints/main.ts init
```

### Sync Onboarding Content
Fetch and synchronize documents locally (based on `.sateng/onboarding.json` targets):
```bash
npx ts-node src/entrypoints/main.ts onboard
```
