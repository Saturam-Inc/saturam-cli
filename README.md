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

- AI provider (Anthropic, OpenAI, Gemini, Bedrock, Grok, DeepSeek, Ollama)
- API keys
- SCM provider (GitHub, Bitbucket, or GitLab)

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

Initialize configuration for a project.

```bash
sat-cli init
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

```
? Which source control platforms do you use? GitLab
? GitLab personal access token: glpat-...
? GitLab instance URL (leave empty for gitlab.com): https://git.example.com
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

## Configuration

Configuration is stored in `~/Library/Application Support/sateng/config.json` (macOS) or `~/.config/sateng/config.json` (Linux/Windows). Run `sat-cli init` to set it up interactively.

### Environment variables

All settings can also be provided via environment variables, which take priority over the config file.

**AI providers**

| Variable            | Provider                                   |
| ------------------- | ------------------------------------------ |
| `ANTHROPIC_API_KEY` | Anthropic (Claude)                         |
| `OPENAI_API_KEY`    | OpenAI (GPT)                               |
| `GOOGLE_API_KEY`    | Google (Gemini)                            |
| `XAI_API_KEY`       | xAI (Grok)                                 |
| `DEEPSEEK_API_KEY`  | DeepSeek                                   |
| `AWS_PROFILE`       | AWS Bedrock                                |
| `AWS_REGION`        | AWS Bedrock region (default: `us-east-1`)  |
| `OLLAMA_BASE_URL`   | Ollama (default: `http://localhost:11434`) |

**SCM platforms**

| Variable              | Description                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`        | GitHub personal access token                                                    |
| `BITBUCKET_EMAIL`     | Atlassian account email (used as username for Basic auth)                       |
| `BITBUCKET_TOKEN`     | Bitbucket API token (create at Atlassian account → Security → API tokens)      |
| `GITLAB_TOKEN`        | GitLab personal access token (`api` scope required)                             |
| `GITLAB_INSTANCE_URL` | Base URL for self-hosted GitLab (e.g. `https://git.example.com`)                |

## License

UNLICENSED
