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

- AI provider (Anthropic, OpenAI, Gemini, Bedrock, Grok, DeepSeek, Ollama, OpenRouter)
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
| `OPENAI_BASE_URL`   | OpenAI-compatible API (e.g., OpenRouter)  |
| `GOOGLE_API_KEY`    | Google (Gemini)                            |
| `XAI_API_KEY`       | xAI (Grok)                                 |
| `DEEPSEEK_API_KEY`  | DeepSeek                                   |
| `AWS_PROFILE`       | AWS Bedrock                                |
| `AWS_REGION`        | AWS Bedrock region (default: `us-east-1`)  |
| `OLLAMA_BASE_URL`   | Ollama (default: `http://localhost:11434`) |

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
