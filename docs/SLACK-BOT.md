# The Slack bot

`sat-cli onboard` also runs as a Slack bot: the same answering flow, packaged as two AWS Lambda
functions. Mention it in a channel or DM it; it answers in a thread with sources, follow-up buttons
and 👍/👎 feedback. Each thread is one conversation, and each person's recent history carries across
their threads.

This page is what the code guarantees and what it needs. How the bot is stood up in an AWS account
(the resources, IAM, environment values, secrets and the setup guide) lives in the private
repository, `sat-cli-internal-infra/onboarding-slack-lamba`.

## What gets deployed

| Entry point       | Runs where                | Source                                    | Purpose                                                     |
| ----------------- | ------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `ingress.handler` | Lambda behind API Gateway | `src/entrypoints/slack-ingress.lambda.ts` | Receives Slack events, replies within 3 s, queues questions |
| `worker.handler`  | Lambda triggered by SQS   | `src/entrypoints/slack-worker.lambda.ts`  | Answers queued questions with the `onboard` flow            |
| `pnpm slack:dev`  | your machine              | `src/entrypoints/slack-socket-mode.ts`    | The whole bot locally over Socket Mode                      |
| `sat-cli onboard` | a terminal                | `src/entrypoints/main.ts`                 | Unchanged; the bot shares its `AnswerFlowService`           |

Both handlers ship in one zip: `pnpm slack:bundle` → `dist/slack-bot/slack-bot-lambda.zip` (about
3 MB), built by `scripts/build-slack-lambda.mjs`. The build fails if the bundle reaches anything
outside the answering path (the CLI's commands, code review, SCM or ingestion integrations), so the
Lambda never carries them. Of the model providers, Bedrock (`@langchain/aws`), Claude on Azure AI
Foundry (`@langchain/anthropic`) and Azure OpenAI (`@langchain/openai`) are included; the rest stay
out.

Why two functions and a queue: Slack needs a reply within 3 seconds, but an answer takes 10–40
seconds while the agent searches, reads and searches again. The ingress replies at once and the
worker does the slow part. A FIFO queue keeps one thread's questions in order and lets different
threads run in parallel.

## How a question flows

```
Slack   "@bot how does the scheduler work?"
  │  HTTPS POST, signed by Slack
  ▼
API Gateway (HTTP API)   POST /slack/events
  ▼
ingress Lambda                                          replies to Slack in ~1–2 s
  1  check Slack's signature      ◀──  Secrets Manager   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
  2  record the delivery          ──▶  DynamoDB          slack-event#…   (Slack's retries are dropped)
  3  check the allow-lists
  4  post the placeholder         ──▶  Slack             "Searching the knowledge base…"
  5  queue the question           ──▶  SQS FIFO          job: kind, ids, question, placeholder
  ▼
worker Lambda   (SQS trigger, one job per run)          10–40 s
  1  load the project list        ◀──  S3                <state prefix>/registry.json
  2  read and save history        ◀─▶  DynamoDB          slack#<team>#<user>
  3  search the docs (repeats)    ◀──  Bedrock           Knowledge Base Retrieve
  4  write the answer             ◀─▶  Bedrock           Claude (SATENG_MODEL)
  5  replace the placeholder      ──▶  Slack
  ▼
Slack   answer · sources · follow-up buttons · 👍/👎
```

Failed attempts: the queue redelivers a job up to `SLACK_WORKER_MAX_ATTEMPTS` times, 15 s apart,
with a "Still working…" notice; after the last one the placeholder becomes an apology with a
reference ID. Button clicks take the same path: a follow-up queues a new question, and 👍/👎 queues a
feedback job stored under `slack-feedback#<team>`.

## Deployment contract

These are what the private deployment relies on. Renaming or reshaping one is a
deployment-contract change: bump the minor version, say so in the release notes, and the deployer
updates the function settings in the same change.

| Item                                                                                                                                                                                                                                                                                                 | Defined in                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler names `ingress.handler` and `worker.handler` (files `ingress.js`, `worker.js` at the zip root); one zip for both functions                                                                                                                                                                   | `scripts/build-slack-lambda.mjs` entry points                                                                                                                                                             |
| `SLACK_*` environment variables                                                                                                                                                                                                                                                                      | `SLACK_ENV` in `src/slack/slack-settings.ts`                                                                                                                                                              |
| `SATENG_*` environment variables                                                                                                                                                                                                                                                                     | `CONFIG_ENV` in `src/services/config-environment.ts`; `SATENG_BEDROCK_PROFILE_PREFIX` in `src/services/llm-service.ts`; `SATENG_LLM_SECRET_ID` and the Azure secret keys in `src/slack/lambda-runtime.ts` |
| Secret keys `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`                                                                                                                                                                                                                                                | `SecretPayloadSchema` in `src/slack/slack-settings.ts`                                                                                                                                                    |
| Event shapes: API Gateway HTTP API payload 2.0; SQS records                                                                                                                                                                                                                                          | `src/entrypoints/slack-ingress.lambda.ts`, `slack-worker.lambda.ts`                                                                                                                                       |
| Queue semantics: FIFO with content-based dedup off, dedup id = job id, group = channel:thread; redrive `maxReceiveCount` = `SLACK_WORKER_MAX_ATTEMPTS`; the trigger reports batch item failures; the worker calls `sqs:ChangeMessageVisibility`; visibility timeout longer than the worker's timeout | `src/slack/slack-jobs.ts`, `src/slack/job-queue.ts`, `slack-worker.lambda.ts`                                                                                                                             |
| DynamoDB table with `pk`/`sk` strings and TTL on `expiresAt`; item families `slack#`, `slack-event#`, `slack-feedback#` beside the CLI's `session#` items                                                                                                                                            | `src/slack/slack-state.service.ts`, `src/services/knowledge/dynamodb-conversation-store.ts`                                                                                                               |
| Model IDs the package accepts                                                                                                                                                                                                                                                                        | `LLMModel` in `src/constants/llm-models.ts`                                                                                                                                                               |
| Runtime Node.js 22 (build target `node22`; building the zip needs Node ≥ 22.2)                                                                                                                                                                                                                       | `scripts/build-slack-lambda.mjs`                                                                                                                                                                          |

Environment variables the two functions read (the values are the deployer's):

| Variable                                                                                                                            | Function | Purpose                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `SLACK_SECRET_ID`                                                                                                                   | both     | Secrets Manager secret holding the Slack tokens                 |
| `SLACK_JOB_QUEUE_URL`                                                                                                               | both     | The FIFO queue; unset means answer in-process (local runs)      |
| `SATENG_CONVERSATION_TABLE`                                                                                                         | both     | History, delivery de-duplication, feedback                      |
| `SLACK_WORKER_MAX_ATTEMPTS`                                                                                                         | worker   | Must equal the queue's redrive maximum receives (default 2)     |
| `SATENG_MODEL`, `SATENG_BEDROCK_PROFILE_PREFIX`                                                                                     | worker   | Bedrock model id and, when needed, its inference-profile prefix |
| `SATENG_KB_ID`, `SATENG_S3_BUCKET`, `SATENG_S3_PREFIX`, `SATENG_S3_STATE_PREFIX`                                                    | worker   | The knowledge base and where `registry.json` is read from       |
| `SATENG_CONVERSATION_TTL_DAYS`, `SATENG_KB_REGION`, `SATENG_S3_REGION`, `SATENG_CONVERSATION_TABLE_REGION`, `SATENG_BEDROCK_REGION` | worker   | Optional                                                        |
| `SATENG_LLM_SECRET_ID`                                                                                                              | worker   | Azure providers only: the secret holding their credentials      |
| `SLACK_ALLOWED_TEAM_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, `SLACK_ALLOW_DIRECT_MESSAGES`                                                | ingress  | Access control                                                  |
| `LOG_LEVEL`, `NODE_OPTIONS`                                                                                                         | both     | `info` or `debug`; `--enable-source-maps`                       |

## Releases

The bot's code is released with the CLI. On a version tag (`vX.Y.Z`, matching `package.json`), the
workflow `.github/workflows/release-slack-bot.yml` runs the tests, builds the package and attaches
`slack-bot-lambda.zip` and a `.sha256` file to the tag's GitHub Release. The private deployment
downloads that zip by tag and updates both functions. Run the workflow by hand on a branch to get the
same zip as a workflow artifact, for testing before a release. Every PR also builds the package, so
an import that would drag CLI-only code into the Lambda fails in CI.

## Local development (Socket Mode)

Socket Mode runs the whole bot on your machine without API Gateway or a queue; Slack pushes events
over a WebSocket.

1. Create a development Slack app. Never reuse a production app: Socket Mode turns off its HTTP
   delivery. It needs bot token scopes `app_mentions:read`, `chat:write` and `im:history`, bot events
   `app_mention` and `message.im`, the Messages tab on, and Socket Mode enabled. Generate an
   app-level token with the `connections:write` scope (`xapp-…`) and install the app (`xoxb-…`).
2. Create a `.env` at the repository root (git-ignored):

    ```bash
    SLACK_APP_TOKEN=xapp-...
    SLACK_BOT_TOKEN=xoxb-...
    SATENG_MODEL=anthropic.claude-sonnet-4-6
    SATENG_BEDROCK_PROFILE_PREFIX=global      # if your region offers the model only as global.*
    SATENG_KB_ID=<knowledge base id>
    SATENG_S3_BUCKET=<bucket>
    SATENG_S3_PREFIX=onboarding
    # SATENG_CONVERSATION_TABLE=<table>       # optional; otherwise history stays in memory
    AWS_PROFILE=<a profile allowed bedrock:InvokeModel, bedrock:Retrieve and s3:GetObject>
    AWS_REGION=<region>
    ```

3. `pnpm slack:dev`, then mention or DM the development bot.

## How conversations behave

- A thread is a conversation. Starting a new thread is the Slack equivalent of `--new-session`.
- Each person's history carries across their threads. Two people in one thread each keep their own
  context.
- In channels the bot must be mentioned every time, including in its own threads. In DMs each
  top-level message starts a thread.
- Follow-up buttons ask on behalf of whoever clicks, and the answer shows who asked. 👍/👎 is stored
  per answer and per rater; a second click replaces the first.

## Security notes

- Every request is authenticated by Slack's HMAC signature over the raw body; anything older than
  5 minutes is rejected, and the ingress refuses to run without a signing secret rather than skip
  the check.
- Neither function holds AWS keys; the execution roles grant only what each function calls. The
  ingress cannot read the knowledge base or conversations, or invoke the model.
- Answers pass the CLI's guards: credential-shaped text is redacted, and identifiers the sources
  never mention are revised away. Errors shown in Slack carry a reference ID, never internals.
- At `LOG_LEVEL` `info` the logs record IDs, timings and outcomes, not questions or answers; the one
  exception is a failed knowledge-base search, which logs its query. At `debug`, every search query
  is logged.

## Models

The default is Claude on Amazon Bedrock, invoked with the worker's IAM role, so no model credentials
exist anywhere. `SATENG_MODEL` is the bare model id (`anthropic.claude-sonnet-4-6` or
`anthropic.claude-haiku-4-5-20251001-v1:0`); the code adds the region's cross-region inference-profile
prefix, or `SATENG_BEDROCK_PROFILE_PREFIX` when the region offers the model under another one, such
as `global`. The package also carries Claude on Azure AI Foundry (`azure-foundry-claude`) and Azure
OpenAI (`azure-openai-custom`); those read their credentials from the secret named by
`SATENG_LLM_SECRET_ID`. Any other configured model is refused at cold start with a log line saying
so.
