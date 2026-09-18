# saturam-cli

AI-powered code review CLI with multi-agent architecture. Posts inline comments on GitHub, Bitbucket, and GitLab MRs.

## Installation

```bash
npm install -g saturam-cli
```

## Setup

```bash
sat-cli init
```

This will configure:

- AI provider (Anthropic, OpenAI, Gemini, Bedrock, Grok, DeepSeek, Ollama, Self Hosted LLM, OpenRouter)
- API keys
- SCM provider (GitHub, Bitbucket, or GitLab)
- Integration credentials (Atlassian Jira/Confluence, Google Drive/Docs/Sheets)

## Commands

### `sat-cli review`

Run a multi-agent AI code review on a pull request.

```bash
# Review by PR number (detects repo from current directory)
sat-cli review 9

# Review by PR URL
sat-cli review https://github.com/org/repo/pull/9

# Self-review — display in terminal only, don't post to GitHub
sat-cli review 9 --self

# Auto-post without confirmation
sat-cli review 9 --post

# CI mode (no interactive prompts)
sat-cli review 9 --auto --post

# Include ticket context
sat-cli review 9 --ticket "Implement user auth with OAuth2"
sat-cli review 9 --ticket ./requirements.md

# Keep review artifacts for debugging
sat-cli review 9 --keep-artifacts
```

**How it works:**

1. Two independent AI reviewers analyze the PR from different angles
2. An auditor cross-validates both reviews against the diff
3. Findings are extracted as structured JSON with exact code references
4. Comments are posted on the exact lines in the diff

### `sat-cli add-skill`

Install AI coding skills into Claude Code or Cursor.

```bash
# Interactive — pick skill and target tool
sat-cli add-skill

# Specify skill name
sat-cli add-skill code-review

# Fully non-interactive
sat-cli add-skill code-review --tool claude-code
sat-cli add-skill code-review --tool cursor
```

**Available skills:**

- `code-review` — Multi-model code review with inline comments

### `sat-cli init`

Initialize configuration for a project (AI providers, default model, SCM credentials, Atlassian integrations, and Google Drive integrations).

```bash
sat-cli init
```

### `sat-cli onboard`

Sync project onboarding documentation locally from Atlassian (Jira & Confluence) and Google Drive (Docs & Sheets).

```bash
# Sync using local config file (.sateng/onboarding.json)
sat-cli onboard

# Sync directly from a Google Sheet URL or ID — either a structured project sheet
# (one row per project, see onboarding-sheet-template.csv) or a "sheet of links"
# (cells scanned for Confluence/Jira/Drive URLs), auto-detected from the header row
sat-cli onboard <spreadsheet-url-or-id>

# Write a sample .sateng/onboarding.json (Confluence/Jira/Google Drive examples) to the
# repository root, instead of syncing — never overwrites an existing onboarding.json
sat-cli onboard --format

# Restrict the sync to just the matching projects.<project-name> section of your onboarding
# config (global, non-project entries are skipped), and use it as the output folder name
# (e.g. onboarding/<project-name>/confluence/... instead of each config/tab-derived name)
sat-cli onboard --project-name "Saturam Core"
sat-cli onboard <spreadsheet-url-or-id> --project-name "Saturam Core"

# Upload the documents synced in this run to the configured S3 bucket
# (requires AWS S3 to be configured — see "Cloud" below)
sat-cli onboard --project-name "Saturam Core" --upload-to-s3

# List locally synced documents, grouped by project name, without syncing
sat-cli onboard --list

# Interactively test the configured Bedrock Knowledge Base using retrieval only
sat-cli onboard --knowledge-base

# Ask questions and get a mentoring answer grounded in the Knowledge Base.
# The project is worked out per question — no --project flag needed.
sat-cli onboard --chat

# Start over with a fresh conversation instead of continuing the last one
sat-cli onboard --chat --new-session
```

### How `--chat` answers

Each question runs through a small chain of agents rather than a single retrieval-and-summarize step:

1. **Intent classification** — is this a general engineering question, a question about one of our projects, or a question about what the assistant knows? General questions are answered directly, without retrieval.
2. **Automatic project routing** — the project is resolved from the question, from the project you have been discussing, or by retrieving broadly and seeing which project the matching documents actually belong to. You are asked to choose only when two projects are genuinely plausible.
3. **Mentoring answer** — answers the question, explains why the thing exists, how it works, where it lives, and what to watch out for, rather than quoting document excerpts back.
4. **Follow-up suggestions** — three or four questions you can select to keep going, each one grounded in material the Knowledge Base can actually answer.

Conversation history is kept so follow-ups work: "and how does it fail?" is understood against the previous answer. History lives in memory by default, or in DynamoDB when a `conversationTable` is configured (see "Cloud" below), which is what lets a later run continue the same conversation.

Once you've synced from a structured project sheet, its ID is remembered in your personal config — plain `sat-cli onboard` (no argument, from any directory) automatically re-checks that same sheet for the latest values on every run, instead of relying on a possibly-stale local file. Passing an explicit config path always overrides this and loads that file directly.

For more details on onboarding sync configuration and features — including the full structured-sheet column reference ([`onboarding-sheet-template.csv`](onboarding-sheet-template.csv)) — see [ONBOARDING.md](ONBOARDING.md).

`--knowledge-base` opens an interactive prompt in the terminal. Enter a question to display the ranked chunks, relevance scores, source locations, and metadata returned by Bedrock. This uses the Knowledge Base `Retrieve` API—the equivalent of the AWS console's **Standard retrieval only** mode—and does not generate an AI answer. Submit an empty question, type `exit`, `quit`, or `:q`, or press Ctrl+C to leave the prompt.

`--chat` is the RAG version: each question is first sent through the same Knowledge Base retrieval as `--knowledge-base`, then the retrieved chunks plus your question are sent to your **configured LLM** (whichever AI/LLM provider and model are set up via `sat-cli init` → "AI / LLM providers" — Anthropic, OpenAI, Gemini, Bedrock, etc.) to produce a synthesized answer instead of raw chunks. Add `--project "Saturam"` to apply a Bedrock metadata filter (`project = saturam`) and restrict the answer to that project's indexed documents. If no LLM provider is configured yet, it tells you to run `sat-cli init` first instead of failing partway through. Requires both an LLM provider and Bedrock Knowledge Base to be configured.

## Cloud (AWS S3 & Bedrock Knowledge Base)

`sat-cli` can connect to cloud storage and retrieval services, independent of the AWS Bedrock **AI provider** described above (that one runs chat models; this one is for object storage and RAG-style document retrieval).

Configure it interactively:

```bash
sat-cli init
# → "Cloud (AWS / Azure / GCP)" → AWS
```

The wizard walks you through, printing instructions for each step:

1. **AWS credentials** — either an existing `aws configure` CLI profile, or an IAM user's Access Key ID / Secret Access Key (create one at [IAM → Users → Security credentials → Create access key](https://console.aws.amazon.com/iam/home#/users)).
2. **S3 bucket access** (optional) — bucket name, key prefix, and region. The IAM identity needs a policy granting `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket` on the bucket.
3. **Bedrock Knowledge Base retrieval** (optional) — the Knowledge Base ID (and optionally Data Source ID) from [Bedrock → Knowledge bases](https://console.aws.amazon.com/bedrock/home#/knowledge-bases). The IAM identity needs `bedrock:Retrieve` on the knowledge base.

Azure and GCP are selectable in the same menu but not yet implemented.

Equivalent environment variables (used as fallbacks by the underlying AWS SDK credential chain when no profile/keys are stored in config): `AWS_PROFILE`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`.

## Ollama

`sat-cli` supports local Ollama and remote Ollama endpoints behind an API gateway.

Local Ollama does not require a token:

```json
{
    "providers": {
        "ollama": {
            "enabled": true,
            "baseUrl": "http://localhost:11434",
            "model": "qwen2.5-coder:latest"
        }
    },
    "defaultProvider": "ollama",
    "defaultModel": "ollama-custom"
}
```

For a remote Ollama gateway, keep Ollama private and expose only the gateway URL. If the gateway requires bearer authentication, add `apiToken`; requests include `Authorization: Bearer <apiToken>`.

```json
{
    "providers": {
        "ollama": {
            "enabled": true,
            "baseUrl": "http://<VM_PUBLIC_IP>:8080",
            "apiToken": "saturam-dev-token-123",
            "model": "qwen2.5-coder:latest"
        }
    },
    "defaultProvider": "ollama",
    "defaultModel": "ollama-custom"
}
```

During `sat-cli init`, the token prompt is shown only for non-local Ollama URLs.

## Self Hosted LLM

Use the Self Hosted LLM provider for an Ollama-compatible endpoint that should be configured separately from the built-in Ollama provider.

```json
{
    "providers": {
        "self-hosted": {
            "enabled": true,
            "endpoint": "http://<VM_PUBLIC_IP>:11434",
            "model": "qwen2.5-coder:latest"
        }
    },
    "defaultProvider": "self-hosted",
    "defaultModel": "selfhosted-custom"
}
```

If the endpoint requires bearer authentication, add `accessToken`:

```json
{
    "providers": {
        "self-hosted": {
            "enabled": true,
            "endpoint": "https://llm.example.com",
            "model": "qwen2.5-coder:latest",
            "accessToken": "your-token"
        }
    },
    "defaultProvider": "self-hosted",
    "defaultModel": "selfhosted-custom"
}
```

Equivalent environment variables:

```bash
export SELF_HOSTED_ENDPOINT=http://<VM_PUBLIC_IP>:11434
export SELF_HOSTED_MODEL=qwen2.5-coder:latest
export SELF_HOSTED_ACCESS_TOKEN=your-token
```

For large reviews or slower models, increase the request timeout:

```bash
SELF_HOSTED_TIMEOUT_MS=600000 sat-cli --model selfhosted-custom review 9 --self
```

## Bitbucket

`sat-cli` supports Bitbucket Cloud (`bitbucket.org`).

### Authentication

Bitbucket uses **API tokens** (App Passwords were deprecated on September 9, 2025 and will be fully disabled on June 9, 2026).

API tokens use **Basic auth** with your **Atlassian account email** as the username. You need both your email and the token.

**Step 1 — Create an API token:**

1. Go to **[Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens)** (not Bitbucket settings)
2. Click **Create and manage API tokens**
3. Click **Create API token with scopes**
4. Give it a name, set an expiry date, click **Next**
5. Select **Bitbucket** as the app, click **Next**
6. Enable scopes: **Repositories** → Read, **Pull requests** → Read + Write
7. Click **Create token** and copy it immediately (shown only once)

**Step 2 — Set your credentials:**

```bash
export BITBUCKET_EMAIL=your-atlassian-email@example.com
export BITBUCKET_TOKEN=your-api-token
```

**Verify it works:**

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -u "$BITBUCKET_EMAIL:$BITBUCKET_TOKEN" \
  https://api.bitbucket.org/2.0/user
# Should print: 200
```

Or save permanently via `sat-cli init` (select Bitbucket, enter your email and token when prompted).

### Running a review

```bash
# Review by PR number (auto-detects workspace/repo from git remote)
sat-cli review 42

# Review by PR URL
sat-cli review https://bitbucket.org/your-workspace/your-repo/pull-requests/42

# Auto-post without confirmation
sat-cli review 42 --post
```

### Persistent configuration

Instead of env vars, save once via `sat-cli init`:

```
? Which source control platforms do you use? Bitbucket
? Atlassian account email: you@example.com
? Bitbucket API token: ••••••••
```

This writes to `~/.config/sateng/config.json` (Linux) or `%APPDATA%\sateng\config.json` (Windows).

## GitLab

`sat-cli` supports both gitlab.com and self-hosted GitLab instances.

### Authentication

Set your personal access token (requires `api` scope):

```bash
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
```

### Self-hosted instances

If your GitLab is hosted at a custom URL, set:

```bash
export GITLAB_INSTANCE_URL=https://git.example.com
```

Without this, the CLI defaults to `https://gitlab.com`. This is required for any self-hosted instance.

## OpenRouter

`sat-cli` supports OpenRouter as an OpenAI-compatible provider, giving you access to a wide variety of models.

### Configuration Steps

1. **Create an API key from OpenRouter**
    - Visit [OpenRouter.ai](https://openrouter.ai) and sign up
    - Generate an API key from your dashboard

2. **Configure the OpenAI provider with OpenRouter settings:**

    **Option A: Environment variables**

    ```bash
    export OPENAI_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxx
    export OPENAI_BASE_URL=https://openrouter.ai/api/v1
    ```

    **Option B: Interactive setup via `sat-cli init`**

    ```
    ? OpenAI API key: sk-or-v1-xxxxxxxxxxxxxxxxxxxx
    ? OpenAI base URL (leave empty for default OpenAI API): https://openrouter.ai/api/v1
    ```

    **Note:**
    - If you are using the official OpenAI API, use: `https://api.openai.com/v1`
    - If you are using OpenRouter, use: `https://openrouter.ai/api/v1`

3. **Select any of the supported free models listed below**

### Available Free Models

When using OpenRouter, you can access free models like:

- `anthropic/claude-3.5-haiku`
- `google/gemma-2-9b-it`
- `meta-llama/llama-3.1-8b-instruct`
- `microsoft/wizardlm-2-8x22b`
- `qwen/qwen-2.5-7b-instruct`

### Available Premium Models

Premium models also available:

- `anthropic/claude-3.5-sonnet`
- `openai/gpt-4o`
- `google/gemini-pro-1.5`
- `meta-llama/llama-3.1-70b-instruct`
- And many more from the OpenRouter model registry

**Important:** Use the model name exactly as shown in OpenRouter's model list when configuring your default model.

### Running a review

```bash
# Review by MR number (detects repo and instance from current directory + env)
sat-cli review 42

# Review by MR URL
sat-cli review https://git.example.com/namespace/repo/-/merge_requests/42

# Auto-post without confirmation
sat-cli review 42 --post
```

### Persistent configuration

Instead of env vars, you can save these values once via `sat-cli init`:

For example, by selecting the OpenAI provider:

```
? Which source control platforms do you use? GitLab
? GitLab personal access token: glpat-...
? GitLab instance URL (leave empty for gitlab.com): https://git.example.com
? OpenAI API key: sk-or-v1-...
? OpenAI base URL (leave empty for default OpenAI API): https://openrouter.ai/api/v1
```

This writes to `~/Library/Application Support/sateng/config.json` (macOS) or `~/.config/sateng/config.json` (Linux).

## Local Development

```bash
git clone https://github.com/Saturam-Inc/saturam-cli.git
cd saturam-cli
pnpm install
pnpm build
npm link
```

After `npm link`, `sat-cli` is available globally from your terminal.

To rebuild after changes:

```bash
pnpm build
```

### Running tests

Tests use [Jest](https://jestjs.io/) with `ts-jest` — no build step needed.

```bash
# Run all tests
pnpm test

# Run a specific test file
pnpm test -- tests/github/services/git.service.test.ts

# Run tests matching a name pattern
pnpm test -- --testNamePattern "GitLab"
```

**Example output:**

```
PASS tests/integrations/github/utils/github-url.util.test.ts
PASS tests/github/services/git.service.test.ts

Test Suites: 2 passed, 2 total
Tests:       6 passed, 6 total
```

Test files live under `tests/`, mirroring the `src/` directory structure.

## Configuration

Configuration is stored in `~/Library/Application Support/sateng/config.json` (macOS) or `~/.config/sateng/config.json` (Linux/Windows). Run `sat-cli init` to set it up interactively.

### Environment variables

All settings can also be provided via environment variables, which take priority over the config file.

**AI providers**

| Variable                   | Provider / setting                                                         |
| -------------------------- | -------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | Anthropic (Claude)                                                         |
| `OPENAI_API_KEY`           | OpenAI (GPT)                                                               |
| `OPENAI_BASE_URL`          | OpenAI-compatible API (e.g., OpenRouter)                                   |
| `GOOGLE_API_KEY`           | Google (Gemini)                                                            |
| `XAI_API_KEY`              | xAI (Grok)                                                                 |
| `DEEPSEEK_API_KEY`         | DeepSeek                                                                   |
| `AWS_PROFILE`              | AWS Bedrock (also used for S3/Cloud — see below)                           |
| `AWS_REGION`               | AWS region — Bedrock, S3, and Bedrock Knowledge Base all fall back to this |
| `OLLAMA_BASE_URL`          | Ollama (default: `http://localhost:11434`)                                 |
| `OLLAMA_API_TOKEN`         | Optional bearer token for remote Ollama                                    |
| `SELF_HOSTED_ENDPOINT`     | Self Hosted LLM endpoint                                                   |
| `SELF_HOSTED_MODEL`        | Self Hosted LLM model name                                                 |
| `SELF_HOSTED_ACCESS_TOKEN` | Optional bearer token for Self Hosted LLM                                  |
| `SELF_HOSTED_TIMEOUT_MS`   | Self Hosted LLM request timeout                                            |

**SCM platforms**

| Variable              | Description                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| `GITHUB_TOKEN`        | GitHub personal access token                                              |
| `BITBUCKET_EMAIL`     | Atlassian account email (used as username for Basic auth)                 |
| `BITBUCKET_TOKEN`     | Bitbucket API token (create at Atlassian account → Security → API tokens) |
| `GITLAB_TOKEN`        | GitLab personal access token (`api` scope required)                       |
| `GITLAB_INSTANCE_URL` | Base URL for self-hosted GitLab (e.g. `https://git.example.com`)          |

**Integration services (Onboarding & Knowledge Retrieval)**

| Variable              | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| `ATLASSIAN_EMAIL`     | Atlassian account email (username for general Jira & Confluence access) |
| `ATLASSIAN_TOKEN`     | Atlassian API token (for general Jira & Confluence access)              |
| `CONFLUENCE_EMAIL`    | Confluence-specific account email (overrides `ATLASSIAN_EMAIL`)         |
| `CONFLUENCE_TOKEN`    | Confluence-specific API token (overrides `ATLASSIAN_TOKEN`)             |
| `JIRA_EMAIL`          | Jira-specific account email (overrides `ATLASSIAN_EMAIL`)               |
| `JIRA_TOKEN`          | Jira-specific API token (overrides `ATLASSIAN_TOKEN`)                   |
| `GOOGLE_ACCESS_TOKEN` | Google OAuth access token (for Google Drive, Docs, and Sheets access)   |

## License

UNLICENSED
