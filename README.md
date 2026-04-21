# saturam-cli

AI-powered code review CLI with multi-agent architecture. Posts inline comments on GitHub/Bitbucket PRs.

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
- SCM provider (GitHub or Bitbucket)

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

Configuration is stored in `.sateng.yaml` in your project root (created by `sat-cli init`).

```yaml
provider: anthropic
model: claude-sonnet-4-20250514
github:
  token: ghp_...
```

Environment variables are also supported:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `GITHUB_TOKEN`

## License

UNLICENSED
