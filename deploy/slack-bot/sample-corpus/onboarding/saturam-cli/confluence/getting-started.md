# sat-cli — getting started

sat-cli is Saturam's engineering command-line tool. It is installed with `npm install -g saturam-cli`
and configured once with `sat-cli init`, which stores AI provider keys, source-control tokens and cloud
settings in `~/.config/sateng/config.json`.

## What it does

- `sat-cli review <PR>` runs a multi-agent AI code review on a GitHub, GitLab or Bitbucket pull request.
  Two reviewers analyse the change independently, an auditor cross-checks them, and findings are
  posted as inline comments on the exact lines.
- `sat-cli onboard --chat` answers questions about our projects from the onboarding knowledge base,
  the way a senior engineer would explain them to someone who just joined.
- `sat-cli onboard --knowledge-base` shows the raw passages the knowledge base returns for a question,
  for checking what is indexed.

## Where the knowledge comes from

Documentation is not written into the tool. A scheduled ingestion job reads a Google Sheet listing
each project's Confluence pages, Jira tickets and Google Drive files, converts them to Markdown, and
uploads them to S3. An Amazon Bedrock Knowledge Base indexes that bucket, and `onboard --chat`
searches it.

## Running it locally

Use Node.js 22 and pnpm 9. Clone the repository, run `pnpm install`, and run the CLI with
`pnpm start:dev -- <command>`. Tests run with `pnpm test`.
