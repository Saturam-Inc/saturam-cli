# Contributing to saturam-cli

## Reporting Issues

### Bug Reports

1. Go to [Issues](https://github.com/Saturam-Inc/saturam-cli/issues)
2. Click **New issue**
3. Include:
    - What you expected to happen
    - What actually happened
    - Steps to reproduce
    - CLI version (`sat-cli --version`)
    - Node.js version (`node --version`)
    - Operating system

### Feature Requests

1. Go to [Issues](https://github.com/Saturam-Inc/saturam-cli/issues)
2. Click **New issue**
3. Prefix the title with `[Feature Request]`
4. Describe the feature, why it's useful, and how you'd expect it to work

### Security Vulnerabilities

Do **not** open a public issue for security vulnerabilities. Email security@saturam.com with details.

---

## Contributing Code

### Prerequisites

- Node.js 22+
- pnpm 9+
- Git

### Setup

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/saturam-cli.git
cd saturam-cli

# Install dependencies
pnpm install

# Build
pnpm build

# Link locally to test
npm link
```

### Development Workflow

1. **Create a branch** from `main`

```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes** in the `src/` directory

3. **Build and test**

```bash
pnpm build
```

4. **Commit** with a clear message

```bash
git commit -m "feat: add support for custom review rules"
```

Follow conventional commits:

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation
- `refactor:` — code change that doesn't add a feature or fix a bug

5. **Push** to your fork

```bash
git push origin feature/your-feature-name
```

6. **Open a Pull Request** against `Saturam-Inc/saturam-cli:main`
    - Describe what you changed and why
    - Link any related issues
    - PRs require 1 approving review before merge

### Project Structure

```
saturam-cli/
├── bin/              # CLI entry point
├── src/
│   ├── commands/     # CLI commands (review, add-skill, init)
│   ├── constants/    # LLM model definitions
│   ├── containers/   # Dependency injection setup
│   ├── entrypoints/  # Main entry point
│   ├── integrations/ # GitHub, Bitbucket, SCM abstractions
│   ├── prompts/      # LLM prompt templates
│   ├── services/     # Core services (LLM, config, review)
│   └── utils/        # Shared utilities
├── skills/           # Bundled skill definitions
├── docs/             # Documentation
└── built/            # Compiled output (generated)
```

### Adding a New Command

1. Create `src/commands/your-command.ts` implementing `TypedCommand`
2. Register it in `src/containers/all-commands.ts`
3. Build and test: `pnpm build`

### Adding a New Skill

1. Create `skills/<skill-name>/SKILL.md` with frontmatter (name, description)
2. The skill will automatically appear in `sat-cli add-skill`

---

## Code Guidelines

- TypeScript strict mode
- No `any` types unless unavoidable
- Format with Prettier (`pnpm format`)
- Keep commands thin — business logic goes in services
- Don't add dependencies unless necessary

---

## License

This project is UNLICENSED. By contributing, you agree that your contributions become part of this project under the same license.
