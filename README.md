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

- AI provider (Anthropic, OpenAI, Gemini, Bedrock, Grok, DeepSeek, Ollama, Self Hosted LLM)
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

| Variable                   | Provider / setting                         |
| -------------------------- | ------------------------------------------ |
| `ANTHROPIC_API_KEY`        | Anthropic (Claude)                         |
| `OPENAI_API_KEY`           | OpenAI (GPT)                               |
| `GOOGLE_API_KEY`           | Google (Gemini)                            |
| `XAI_API_KEY`              | xAI (Grok)                                 |
| `DEEPSEEK_API_KEY`         | DeepSeek                                   |
| `AWS_PROFILE`              | AWS Bedrock                                |
| `AWS_REGION`               | AWS Bedrock region (default: `us-east-1`)  |
| `OLLAMA_BASE_URL`          | Ollama (default: `http://localhost:11434`) |
| `OLLAMA_API_TOKEN`         | Optional bearer token for remote Ollama    |
| `SELF_HOSTED_ENDPOINT`     | Self Hosted LLM endpoint                   |
| `SELF_HOSTED_MODEL`        | Self Hosted LLM model name                 |
| `SELF_HOSTED_ACCESS_TOKEN` | Optional bearer token for Self Hosted LLM  |
| `SELF_HOSTED_TIMEOUT_MS`   | Self Hosted LLM request timeout            |

**SCM platforms**

| Variable                 | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `GITHUB_TOKEN`           | GitHub personal access token                                     |
| `BITBUCKET_TOKEN`        | Bitbucket access token                                           |
| `BITBUCKET_APP_PASSWORD` | Bitbucket app password                                           |
| `BITBUCKET_USERNAME`     | Bitbucket username (required with app password)                  |
| `GITLAB_TOKEN`           | GitLab personal access token (`api` scope required)              |
| `GITLAB_INSTANCE_URL`    | Base URL for self-hosted GitLab (e.g. `https://git.example.com`) |

## License

UNLICENSED
