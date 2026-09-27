# Slack bot on AWS — setup from an empty account

This guide builds everything the onboarding Slack bot needs from nothing, almost entirely in the AWS
console. Answers are written by **Claude Sonnet 4.6 on Amazon Bedrock**, so everything runs in one
AWS account and no data leaves it.

- **Part A — the knowledge base.** An S3 bucket of documentation, and a Bedrock Knowledge Base that
  indexes it. A sample corpus is included, so you can test end to end before real ingestion runs.
- **Part B — the Slack bot.** Two Lambda functions, a queue, a table, a secret and an API, plus the
  Slack app.
- **Part C — operating it.** Updates, local development, reference, and troubleshooting.
- **Appendix.** Using another Bedrock model, or a deployment on Azure AI Foundry, instead.

Do the steps in order: most of them use a value an earlier step produced. Collect those values in
the **values sheet** as you go.

- **Time:** about 2–2½ hours the first time.
- **You need:** the access listed under [Services and access](#services-and-access) below.

---

## Services and access

### Services used

| #   | Service                                       | Used for                                                                         | Created in        | Who accesses it at runtime, and with which actions                                                                                   |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Amazon Bedrock — Claude Sonnet 4.6**        | Writes every answer, through a cross-region inference profile                    | A1 (access only)  | **Worker role:** `bedrock:InvokeModel` on the inference profile and the model                                                        |
| 2   | **Amazon Bedrock — Titan Text Embeddings V2** | Turns documents and questions into vectors for search                            | A1 (access only)  | **KB service role** only                                                                                                             |
| 3   | **Amazon Bedrock — Knowledge Bases**          | Indexes the documents and answers searches                                       | A3                | **Worker role:** `bedrock:Retrieve`                                                                                                  |
| 4   | **Amazon S3** (general purpose bucket)        | Documents under `onboarding/`, project list at `onboarding-state/registry.json`  | A2                | **KB service role:** reads `onboarding/`. **Worker role:** `s3:GetObject` on `registry.json` only. The ingestion Lambda writes both  |
| 5   | **Amazon S3 Vectors**                         | Vector store behind the knowledge base                                           | A3 (quick create) | **KB service role** only; the bot never touches it directly                                                                          |
| 6   | **Amazon DynamoDB**                           | Conversation history, record of Slack deliveries already handled, 👍/👎 feedback | B1                | **Worker role:** `Query`, `PutItem`, `UpdateItem`. **Ingress role:** `PutItem`, `DeleteItem`                                         |
| 7   | **AWS Secrets Manager**                       | `saturam/slack-bot` (Slack tokens)                                               | B3                | **Both roles:** `GetSecretValue` on `saturam/slack-bot`                                                                              |
| 8   | **Amazon SQS** (FIFO + dead-letter queue)     | Passes questions from ingress to worker; keeps failures                          | B4                | **Ingress role:** `SendMessage`. **Worker role:** `ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes`, `ChangeMessageVisibility` |
| 9   | **AWS Lambda**                                | The two functions: ingress and worker                                            | B7, B8            | Invoked by API Gateway (permission added automatically) and by the SQS trigger                                                       |
| 10  | **Amazon API Gateway** (HTTP API)             | The public HTTPS URL Slack calls                                                 | B9                | Invokes the ingress Lambda                                                                                                           |
| 11  | **AWS IAM**                                   | Three roles: worker, ingress, and the KB service role                            | B6, A3            | —                                                                                                                                    |
| 12  | **Amazon CloudWatch** (Logs, Alarms)          | Function logs, alarms on failures and slowness                                   | automatic, B12    | **Both roles:** write logs (`AWSLambdaBasicExecutionRole`)                                                                           |
| 13  | **Amazon SNS**                                | Emails when an alarm fires (to any address, e.g. your Gmail)                     | B12               | CloudWatch Alarms publishes to it                                                                                                    |

**Encryption.** Everything uses AWS-managed keys: SSE-S3, SSE-SQS, the DynamoDB default and
`aws/secretsmanager`. No customer-managed KMS keys are created, so no KMS permissions are needed.

**Not used:** EC2, ECR/Docker, VPCs or NAT gateways, and OpenSearch (unless you choose it as the
fallback vector store in A3). Nothing outside AWS is involved: the model, the knowledge base and
the embeddings all run on Bedrock.

- **Keep both Lambdas outside a VPC.** They must reach `slack.com` and the AWS service endpoints
  over the internet, which a Lambda outside a VPC does by default. Attaching them to a VPC would
  need a NAT gateway or VPC endpoints.

### Who talks to what at runtime

```
Slack ──HTTPS──▶ API Gateway ──invoke──▶ ingress Lambda  (saturam-slack-bot-ingress-role)
                                            ├─▶ Secrets Manager   saturam/slack-bot
                                            ├─▶ DynamoDB          record delivery (dedupe)
                                            ├─▶ SQS               send job
                                            └─▶ slack.com         post "Searching…" placeholder

SQS ──trigger──▶ worker Lambda  (saturam-slack-bot-worker-role)
                    ├─▶ Secrets Manager   saturam/slack-bot
                    ├─▶ Bedrock KB        Retrieve
                    ├─▶ S3                read registry.json
                    ├─▶ DynamoDB          read/write conversation, feedback
                    ├─▶ SQS               delete / re-time its own message
                    ├─▶ Bedrock           InvokeModel, Claude Sonnet 4.6 (cross-region profile)
                    └─▶ slack.com         replace placeholder with the answer

Bedrock KB  (AmazonBedrockExecutionRoleForKnowledgeBase_…, created by the console)
                    ├─▶ S3                read onboarding/ documents on sync
                    ├─▶ Bedrock           InvokeModel (Titan embeddings)
                    └─▶ S3 Vectors        write and query vectors
```

All three AWS roles are least-privilege and scoped to the specific resources above. Neither
Lambda role holds AWS keys. The ingress can't read the knowledge base or conversations, or invoke
the model, and the worker can't send new jobs.

### Access the person doing the setup needs

**AWS console.** In a dedicated account, `AdministratorAccess` is simplest. Otherwise, attach
these AWS managed policies to your user or role for the duration of the setup:

| Managed policy                                                                                              | For steps      |
| ----------------------------------------------------------------------------------------------------------- | -------------- |
| `AmazonBedrockFullAccess`                                                                                   | A1, A3, A4     |
| `AmazonS3FullAccess`                                                                                        | A2, A3         |
| `AmazonDynamoDBFullAccess`                                                                                  | B1             |
| `SecretsManagerReadWrite`                                                                                   | B3             |
| `AmazonSQSFullAccess`                                                                                       | B4             |
| `AWSLambda_FullAccess`                                                                                      | B7, B8         |
| `AmazonAPIGatewayAdministrator`                                                                             | B9             |
| `IAMFullAccess` (or at least `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`) | A3, B6, B7, B8 |
| `CloudWatchFullAccess`, `AmazonSNSFullAccess`                                                               | B12            |

`iam:PassRole` is what lets you assign roles to the Lambdas and to the knowledge base. If the
knowledge base's _Quick create_ of S3 Vectors fails with _AccessDenied_, your user also needs
`s3vectors:*` (add it as a small inline policy).

**Bedrock model access.** Claude Sonnet 4.6 must be enabled for the account in your region (A1).
On some accounts Anthropic models need a one-time use-case form before access is granted; the
console asks for it on the model access page. The model's tokens-per-minute quota must cover
concurrent answers (see B7, _Maximum concurrency_).

**Slack.** Permission to create and install apps in the workspace: a workspace admin, or a
workspace that allows members to install apps. The app requests three bot scopes
(`app_mentions:read`, `chat:write`, `im:history`) and subscribes to two events (`app_mention`,
`message.im`).

**Your machine.** Node.js 22.2+ and pnpm 9, only to build the Lambda zip (B5). No Docker is
needed, and the AWS CLI only if you want to upload the zip from the terminal (Part C).

**Not needed for the bot:** Atlassian (Jira, Confluence) and Google credentials. Only the ingestion
pipeline (A5) uses those, and they're configured in that pipeline's own repository.

---

## What gets deployed

The bot runs **only the `sat-cli onboard --chat` answering flow**: the same `AnswerFlowService`,
agent, retrieval, guards and conversation memory as in the terminal. Nothing else from sat-cli
(code review, `init`, SCM or ingestion integrations) is deployed. The build fails if any of it gets
into the Lambda package.

| Entry point              | Runs where                         | Source                                    | Purpose                                                                           |
| ------------------------ | ---------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `ingress.handler`        | Lambda `saturam-slack-bot-ingress` | `src/entrypoints/slack-ingress.lambda.ts` | Receives Slack events, replies within 3 s, queues questions                       |
| `worker.handler`         | Lambda `saturam-slack-bot-worker`  | `src/entrypoints/slack-worker.lambda.ts`  | Answers queued questions with the `onboard --chat` flow                           |
| `pnpm slack:dev`         | your machine                       | `src/entrypoints/slack-socket-mode.ts`    | The whole bot locally over Socket Mode (Part C)                                   |
| `sat-cli onboard --chat` | a terminal                         | `src/entrypoints/main.ts`                 | Unchanged; can use the same model (`sat-cli init` → _AWS Bedrock (Claude, Nova)_) |

Both handlers ship in **one zip** (`pnpm slack:bundle` → `dist/slack-bot/slack-bot-lambda.zip`,
about 3 MB). You upload it to both functions and set a different handler on each.

```
                          ┌──────────── Part A ────────────┐
 documents ─(ingestion)─▶ │ S3  onboarding/<project>/…     │
                          │     onboarding-state/registry  │
                          │          │ sync                │
                          │          ▼                     │
                          │ Bedrock Knowledge Base         │
                          │ (Titan embeddings, S3 Vectors) │
                          └──────────┬─────────────────────┘
                                     │ Retrieve
 ┌──────────────────────── Part B ───┼──────────────────────────────────┐
 │ Slack ─▶ API Gateway ─▶ ingress Lambda ─▶ SQS FIFO ─▶ worker Lambda   │
 │           POST /slack/events   │                 │   (onboard --chat) │
 │                                │                 ├─▶ Bedrock          │
 │               placeholder ◀────┘                 │   Claude Sonnet 4.6│
 │               answer      ◀──────────────────────┘                    │
 │ Secrets Manager: Slack · DynamoDB history · DLQ · alarms              │
 └───────────────────────────────────────────────────────────────────────┘
```

Why two functions and a queue: Slack needs a reply within 3 seconds, but an answer takes 10–40
seconds while the agent searches, reads and searches again. The ingress replies at once, and the
worker does the slow part. The FIFO queue keeps one thread's questions in order and lets different
threads run in parallel.

### How one question flows through the deployed bot

The `log:` lines are what each stage writes to CloudWatch. When something goes wrong, the last of
them that appears tells you which stage to look at
([Finding where a question got stuck](#finding-where-a-question-got-stuck)).

```
 Slack   "@onboarding how does the Slack bot answer a question?"
   │  HTTPS POST, signed by Slack
   ▼
 API Gateway   saturam-slack-bot-api · POST /slack/events
   │
   ▼
 ingress Lambda   saturam-slack-bot-ingress                    replies to Slack in ~1–2 s
   │  1  check Slack's signature   ◀──  Secrets Manager   saturam/slack-bot
   │  2  record the delivery       ──▶  DynamoDB          slack-event#…
   │  3  check the allow-list
   │  4  post the placeholder      ──▶  Slack             "Searching the knowledge base…"
   │  5  queue the question        ──▶  SQS FIFO          saturam-slack-bot-jobs.fifo
   │     log: Queued event:Ev… (mention) in C…/…
   ▼
 SQS trigger   batch size 1 · maximum concurrency 5
   │
   ▼
 worker Lambda   saturam-slack-bot-worker                      10–40 s (timeout 3 min)
   │  1  load the project list     ◀──  S3                onboarding-state/registry.json
   │  2  read and save history     ◀─▶  DynamoDB          slack#<team>#<user>
   │  3  search the docs (repeats) ◀──  Bedrock KB        Retrieve
   │  4  write the answer          ◀─▶  Bedrock           Claude Sonnet 4.6, typically 4–6 calls
   │  5  replace the placeholder   ──▶  Slack             bot token from saturam/slack-bot
   │     log: Answered event:Ev… in …ms (attempt 1/2, … chunk(s), project …)
   ▼
 Slack   answer · sources · follow-up buttons · 👍/👎
```

**When an attempt fails.** The queue allows two attempts (_Maximum receives_ `2`, the same as
`SLACK_WORKER_MAX_ATTEMPTS`):

```
 attempt 1 fails              ──▶  placeholder: "Still working…", retried after 15 s
 attempt 2 fails              ──▶  placeholder: "Sorry — I couldn't answer that just now"
                                   + reference; the message is removed from the queue

 worker crashes or times out  ──▶  no Slack update; SQS retries after the 4-minute
                                   visibility timeout
 same again on attempt 2      ──▶  message moves to saturam-slack-bot-jobs-dlq.fifo
                                   (Dead letters alarm, B12)
```

If the worker can't read `saturam/slack-bot`, it can't post the retry notice or the apology either,
and the placeholder stays on _Searching the knowledge base…_.

**Button clicks** take the same path. A follow-up button queues a new question. 👍/👎 queues a
feedback job, and the worker stores it in DynamoDB (`slack-feedback#<team>`) and privately thanks
the person who clicked.

### Everything you will create

| Step | Resource                                                          | Name used in this guide                                           |
| ---- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| A1   | Bedrock model access: Titan Text Embeddings V2, Claude Sonnet 4.6 | —                                                                 |
| A2   | S3 bucket (documents)                                             | `saturam-onboarding-docs-<ACCOUNT_ID>`                            |
| A3   | Bedrock Knowledge Base + S3 data source + vector store            | `saturam-onboarding-kb`, `onboarding-docs`                        |
| B1   | DynamoDB table                                                    | `saturam-onboarding-conversations`                                |
| B2   | Slack app                                                         | `Saturam Onboarding`                                              |
| B3   | Secrets Manager secret                                            | `saturam/slack-bot`                                               |
| B4   | SQS FIFO queue + dead-letter queue                                | `saturam-slack-bot-jobs.fifo`, `saturam-slack-bot-jobs-dlq.fifo`  |
| B6   | IAM roles                                                         | `saturam-slack-bot-worker-role`, `saturam-slack-bot-ingress-role` |
| B7   | Lambda (worker)                                                   | `saturam-slack-bot-worker`                                        |
| B8   | Lambda (ingress)                                                  | `saturam-slack-bot-ingress`                                       |
| B9   | API Gateway HTTP API                                              | `saturam-slack-bot-api`                                           |
| B12  | SNS topic + CloudWatch alarms                                     | `saturam-slack-bot-alarms`                                        |

**Use one AWS region for everything.** Pick one that offers Titan Text Embeddings V2 and Amazon S3
Vectors; `us-east-1`, `us-west-2` and `ap-south-1` are common choices. The console remembers a
separate region per service, so check the region picker (top right) at the start of every step.
Claude is invoked through a cross-region inference profile, which may route a request to another
region — for these two models in `ap-south-1` that is the `global` profile, so any region Bedrock
serves them from; the knowledge base, table and queues stay where you created them.

---

## Values sheet

Copy this table somewhere and fill it in as you go. The `<PLACEHOLDER>` names match
[`deploy/slack-bot/iam/*.json`](../deploy/slack-bot/iam) and
[`deploy/slack-bot/lambda-env.example`](../deploy/slack-bot/lambda-env.example).

| Placeholder                              | Where it comes from                                     | Example                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `<REGION>`                               | Your choice                                             | `ap-south-1`                                                                                              |
| `<ACCOUNT_ID>`                           | Console top-right → account menu (12 digits, no dashes) | `123456789012`                                                                                            |
| `<BUCKET_NAME>`                          | A2                                                      | `saturam-onboarding-docs-123456789012`                                                                    |
| `<CONTENT_PREFIX>`                       | A2 (fixed by this guide)                                | `onboarding`                                                                                              |
| `<STATE_PREFIX>`                         | A2 (fixed by this guide)                                | `onboarding-state`                                                                                        |
| `<KNOWLEDGE_BASE_ID>`                    | A3                                                      | `ABCDEF1234`                                                                                              |
| `<KB_REGION>`                            | Same as `<REGION>`                                      | `ap-south-1`                                                                                              |
| Data source ID                           | A3 (only the ingestion pipeline needs it)               | `GHIJKL5678`                                                                                              |
| `<TABLE_NAME>`                           | B1                                                      | `saturam-onboarding-conversations`                                                                        |
| Slack signing secret, bot token, team ID | B2                                                      | `8f74…`, `xoxb-…`, `T01ABCDEF`                                                                            |
| `<SECRET_NAME>`                          | B3                                                      | `saturam/slack-bot`                                                                                       |
| `<MODEL_ID>`                             | A1: the bare model ID (Sonnet 4.6 or Haiku 4.5)         | `anthropic.claude-sonnet-4-6`, `anthropic.claude-haiku-4-5-20251001-v1:0`                                 |
| `<PROFILE_PREFIX>`                       | A1: the inference profile's prefix in your region       | `global`                                                                                                  |
| `<QUEUE_NAME>`, queue URL                | B4: the **main** queue, not the dead-letter queue       | `saturam-slack-bot-jobs`, `https://sqs.ap-south-1.amazonaws.com/123456789012/saturam-slack-bot-jobs.fifo` |
| Invoke URL                               | B9                                                      | `https://abc123.execute-api.ap-south-1.amazonaws.com`                                                     |

Keys and tokens go only into Secrets Manager. The sheet should record where they are, not their
values.

---

# Part A — Knowledge base

## A1. Model access

Two models are needed: **Titan Text Embeddings V2**, which turns documents and questions into
vectors for the knowledge base, and **Claude Sonnet 4.6**, which writes the answers.

1. Open **Amazon Bedrock**. If the left menu has **Model access**, open it. (Newer consoles grant
   serverless model access automatically; if the page isn't there, go to step 4.)
2. **Modify model access** (or **Enable specific models**) → tick **Amazon → Titan Text Embeddings
   V2**, **Anthropic → Claude Sonnet 4.6** and **Anthropic → Claude Haiku 4.5** → **Next**. Both
   Claude models are allowed by the worker policy, so you can switch between them later with one
   variable (B7). Anthropic models may ask for a one-time use-case form the first time; fill it in
   → **Submit**. Nothing is "created" or deployed here: Bedrock models are serverless, and access
   is the only setup they need.
3. Wait until all three show **Access granted**.
4. **Find the inference profiles.** Claude is invoked through a cross-region inference profile, not
   the bare model ID. In `ap-south-1` both models are offered only through the **global** profile:
   `global.anthropic.claude-sonnet-4-6` and `global.anthropic.claude-haiku-4-5-20251001-v1:0`. The
   part before the first dot is `<PROFILE_PREFIX>` (`global` here); the rest is `<MODEL_ID>`:
   `anthropic.claude-sonnet-4-6` (no version suffix) and `anthropic.claude-haiku-4-5-20251001-v1:0`.
   Confirm from a terminal, since the list changes as models are added:

    ```bash
    aws bedrock list-inference-profiles --region ap-south-1 \
        --query "inferenceProfileSummaries[?contains(inferenceProfileId,'sonnet-4-6') || contains(inferenceProfileId,'haiku-4-5')].inferenceProfileId"
    ```

    The bot builds the profile ID itself from the function's region (`ap-*` → `apac`, `eu-*` →
    `eu`, otherwise `us`), which is why B7 sets `SATENG_BEDROCK_PROFILE_PREFIX` = `global` and
    takes the bare `<MODEL_ID>`. If your region lists a model under `apac.` instead, leave the
    prefix unset for it.

## A2. S3 bucket and documents

### Create the bucket

1. **S3 → Buckets → Create bucket.**
2. **Bucket type:** _General purpose_. **Bucket name:** `saturam-onboarding-docs-<ACCOUNT_ID>`.
   Bucket names are global, so the account ID keeps it unique.
3. **Object Ownership:** _ACLs disabled_. **Block all public access:** **on** (the default).
4. **Bucket Versioning:** _Enable_. Recovering an overwritten document is then one click.
5. **Default encryption:** _SSE-S3_ (the default). → **Create bucket.**

### The layout the bot expects

The ingestion pipeline writes this layout, and the bot depends on it:

```
s3://<BUCKET_NAME>/
  onboarding/                                  ← <CONTENT_PREFIX>: Bedrock indexes only this
    <project-slug>/<category>/<doc>.md         ← a document
    <project-slug>/<category>/<doc>.md.metadata.json
  onboarding-state/                            ← <STATE_PREFIX>: never indexed
    registry.json                              ← the list of projects
```

- **Metadata file.** Each document has a metadata file beside it: the same name with
  `.metadata.json` appended. Its `project` value **must equal** the project's `slug` in
  `registry.json`, because project-scoped searches filter on it. Its `url` and `title` are what the
  bot lists as sources under an answer.
- **Registry.** `registry.json` tells the bot which projects exist. Bedrock can filter by project
  but can't list them.

### Upload the sample corpus

[`deploy/slack-bot/sample-corpus/`](../deploy/slack-bot/sample-corpus) is a one-project corpus in
exactly this layout. Its documents describe sat-cli and this bot, so the answers are easy to check.

1. Open the bucket → **Upload** → **Add folder** → choose `deploy/slack-bot/sample-corpus/onboarding`
   → **Upload**. The console keeps the folder structure, giving `onboarding/saturam-cli/confluence/…`.
2. Back at the bucket root → **Upload → Add folder** →
   `deploy/slack-bot/sample-corpus/onboarding-state` → **Upload**.
3. Check that the bucket root now has two folders, `onboarding/` and `onboarding-state/`, and that
   `onboarding-state/registry.json` exists.

## A3. Bedrock Knowledge Base

1. **Bedrock → Knowledge Bases → Create → Knowledge Base with vector store.**
2. **Provide Knowledge Base details:**
    - **Name:** `saturam-onboarding-kb`
    - **IAM permissions:** _Create and use a new service role_. The console gives this role read
      access to the bucket and to the vector store; no hand-written policy is needed.
    - **Data source:** _Amazon S3_ → **Next**.
3. **Configure data source:**
    - **Data source name:** `onboarding-docs`
    - **S3 URI:** **Browse S3** → the bucket → select the **`onboarding/`** folder. The URI must end
      in `/onboarding/`. Choosing the bucket root would index `registry.json` as a document.
    - **Parsing strategy:** _Amazon Bedrock default parser_.
    - **Chunking strategy:** _Default chunking_.
    - **Data deletion policy:** _Delete_, so removing a document from S3 removes it from search at
      the next sync.
    - **Next.**
4. **Configure data storage and processing:**
    - **Embeddings model:** **Titan Text Embeddings V2**. Keep the default dimensions (1024) and
      type (floating-point).
    - **Vector store:** _Quick create a new vector store_ → **Amazon S3 Vectors**. It is the
      cheapest option, billed by storage and queries with no standing cost. If your region doesn't
      list it, _Amazon OpenSearch Serverless_ works the same way for the bot, but has a significant
      always-on hourly cost.
    - **Next → Create Knowledge Base.** Creation takes a few minutes.
5. On the knowledge base page, copy the **Knowledge Base ID** (`<KNOWLEDGE_BASE_ID>`). Under
   **Data source**, also note the data source's **ID**; only the ingestion pipeline uses it.
6. **Data source → select `onboarding-docs` → Sync.** Wait until the status reads **Available** and
   the last sync shows documents **added** with none failed. The sample corpus adds 2. If some
   failed, open the sync details: the usual cause is a malformed `.metadata.json`.

## A4. Test retrieval in the console

Before any Slack work, check that the knowledge base answers:

1. On the knowledge base page → **Test Knowledge Base**.
2. Leave **Generate responses** turned **off** (this is _Retrieval only_, the same call the bot
   makes).
3. Ask: `How does the Slack bot answer a question?` The results should come from `slack-bot.md`.
4. Open **Configurations → Filters → Add filter**: `project` **equals** `saturam-cli`, then ask
   again. Results still come back. That proves the metadata files were read and project-scoped
   search works.

If step 4 returns nothing while step 3 works, the metadata files weren't applied. Check that their
names are exactly `<doc>.md.metadata.json`, then re-sync.

## A5. Real documents

The sample corpus is only for testing. Real documentation is produced by the **`on-boarding`
ingestion Lambda** in `sat-cli-internal-infra`: it reads the project sheet, converts Confluence,
Jira and Drive content, writes the layout above, updates `registry.json`, and starts a sync. Deploy
it from that repository's `DEPLOY.md` with these values from your sheet:

- the bucket `<BUCKET_NAME>`,
- content prefix `onboarding` and state prefix `onboarding-state`,
- `<KNOWLEDGE_BASE_ID>` and the data source ID (it calls `StartIngestionJob` after uploading).

Until it runs, you can keep adding documents by hand in the same layout. Update `registry.json` and
**Sync** after each change.

---

# Part B — Slack bot

## B1. DynamoDB table

The table holds conversation history (so follow-ups and new threads have context), the bot's record
of Slack deliveries it has already handled, and 👍/👎 feedback. Everything expires through a TTL.

1. **DynamoDB → Tables → Create table.**
2. **Table name:** `saturam-onboarding-conversations`.
3. **Partition key:** `pk`, type **String**. **Sort key:** `sk`, type **String**. Both are
   lowercase and case-sensitive.
4. **Table settings:** _Customize settings_ → **Capacity mode: On-demand**. Leave everything else
   at its default.
5. **Create table**, then wait for **Active**.
6. Open the table → **Additional settings** → **Time to Live (TTL)** → **Turn on** → attribute name
   **`expiresAt`** → **Turn on TTL**.

**Check:** **Overview** shows `pk (String)` / `sk (String)`, and TTL is **On** for `expiresAt`.

## B2. Slack app — first pass (credentials)

Slack verifies the event URL the moment it is saved, and that URL only exists after step B9. So the
app is set up in two passes. This one creates the app with its bot user, scopes and Messages tab,
and collects the credentials.

The app is created **from a manifest** rather than by picking scopes in the UI. The scope picker
doesn't reliably list every scope (see the note at the end of this step), and a manifest sets all
three scopes, the bot's name and the Messages tab in one paste.

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pick your workspace →
   **Next**.
2. Choose the **YAML** tab, delete what's there, and paste the whole of
   [`deploy/slack-bot/slack-app-manifest.initial.yaml`](../deploy/slack-bot/slack-app-manifest.initial.yaml)
   → **Next**.
3. Review the summary. It should list the three bot scopes below → **Create**.

    | Bot token scope     | Why the bot needs it                                       |
    | ------------------- | ---------------------------------------------------------- |
    | `app_mentions:read` | See messages that @mention it in channels                  |
    | `chat:write`        | Post answers, update the placeholder, send private notices |
    | `im:history`        | Read direct messages sent to it                            |

4. **Basic Information → App Credentials → Signing Secret → Show** → copy it.
5. **Install App** (or **OAuth & Permissions → Install to Workspace**) → **Allow** → copy the **Bot
   User OAuth Token** (`xoxb-…`).
6. **Check:** **OAuth & Permissions → Scopes → Bot Token Scopes** shows exactly those three scopes.
7. **Team ID** (optional, for the workspace allow-list): open Slack in a browser. In the URL
   `https://app.slack.com/client/T01ABCDEF/…`, it's the `T…` part.

**If you created the app "From scratch" and a scope is missing from _Add an OAuth Scope_.** The
picker only offers scopes the app doesn't already have. Subscribing to the `app_mention` event adds
`app_mentions:read` automatically, and the name must be typed exactly, plural included
(`app_mentions:read`). The dependable fix is to add it through the manifest instead:

1. **App Manifest** (left menu) → **YAML**.
2. Under `oauth_config: → scopes: → bot:`, make the list exactly `app_mentions:read`, `chat:write`
   and `im:history`.
3. **Save Changes.**
4. Reinstall when Slack asks. The bot token stays the same.

**If Slack says installation needs approval.** Your workspace restricts app installs, and an admin
has to approve the app (Slack sends them the request). That is a workspace setting, not a scope
problem.

## B3. Secrets Manager secret

One secret, holding the Slack credentials. The model needs none: the worker's IAM role is what lets
it invoke Claude on Bedrock (B6), so there is no model key to store, rotate or leak.

1. **Secrets Manager → Store a new secret → Other type of secret.**
2. **Key/value pairs**, with the key names exactly as shown:

    | Key                    | Value                   |
    | ---------------------- | ----------------------- |
    | `SLACK_BOT_TOKEN`      | the `xoxb-…` token (B2) |
    | `SLACK_SIGNING_SECRET` | the signing secret (B2) |

3. **Encryption key:** `aws/secretsmanager` → **Next**.
4. **Secret name:** `saturam/slack-bot` → **Next** → rotation off → **Next** → **Store**.

Both functions read the secret once per cold start and hold the values in memory. They are never
logged.

## B4. SQS queues

Create the dead-letter queue first, because the main queue refers to it.

**Dead-letter queue**

1. **SQS → Create queue → Type: FIFO** (it can't be changed later).
2. **Name:** `saturam-slack-bot-jobs-dlq.fifo`.
3. **Message retention period:** 14 days. **Content-based deduplication:** off.
4. Encryption at the default (SSE-SQS), no dead-letter queue of its own → **Create queue**.

**Main queue**

1. **SQS → Create queue → Type: FIFO** → **Name:** `saturam-slack-bot-jobs.fifo`.
2. **Configuration:**

    | Setting                            | Value         | Why                                                                              |
    | ---------------------------------- | ------------- | -------------------------------------------------------------------------------- |
    | Visibility timeout                 | **4 minutes** | Must be longer than the worker's 3-minute timeout, or the trigger can't be added |
    | Message retention period           | **1 day**     |                                                                                  |
    | Delivery delay / Receive wait time | 0 / 0         |                                                                                  |
    | Content-based deduplication        | **Off**       | The bot sets its own deduplication ID for each job                               |
    | High throughput FIFO               | Off           |                                                                                  |

3. **Dead-letter queue: Enabled** → `saturam-slack-bot-jobs-dlq.fifo` → **Maximum receives: `2`**.
   This number must equal `SLACK_WORKER_MAX_ATTEMPTS` (B7). On the second and final attempt the
   worker posts an apology to the user rather than fail silently.
4. **Create queue.** On the queue's page, **Details → URL** → copy it with the copy icon. It looks
   like `https://sqs.<REGION>.amazonaws.com/<ACCOUNT_ID>/saturam-slack-bot-jobs.fifo`. Both Lambdas
   need this URL as `SLACK_JOB_QUEUE_URL` (B7, B8). Copy the **URL**, not the ARN shown next to it,
   and the main queue's, not the dead-letter queue's.

## B5. Build the Lambda package

This step runs on your machine. From the repository root:

```bash
pnpm install
pnpm slack:bundle
```

Expected output ends with:

```
✔ dist/slack-bot/slack-bot-lambda.zip  3.1 MB
  Ingress handler: ingress.handler
  Worker handler:  worker.handler
```

What the build does:

1. Compiles with `tsc`, which keeps the metadata typedi needs to wire services.
2. Bundles only the two handlers and what they reach, which is the `onboard --chat` flow and the
   model clients for Bedrock and, for the Appendix alternatives, Azure AI Foundry and Azure OpenAI.
3. Fails if code review, CLI commands, SCM or ingestion code, or another provider's SDK has crept
   in.
4. Writes one zip.

## B6. IAM roles

Each function gets its own role with only the permissions it uses.

### Prepare the policies

[`deploy/slack-bot/iam/worker-policy.json`](../deploy/slack-bot/iam/worker-policy.json) and
[`deploy/slack-bot/iam/ingress-policy.json`](../deploy/slack-bot/iam/ingress-policy.json) are
templates. Copy them to `worker-policy.local.json` and `ingress-policy.local.json` in the same
folder — git ignores `*.local.json` there, so your account values never end up in the repository —
and in the copies replace every `<PLACEHOLDER>` with the value from your sheet:

- **`<REGION>`, `<ACCOUNT_ID>`.** In every ARN. The account ID is 12 digits, no dashes.
- **`<SECRET_NAME>`.** Both policies name one secret, `saturam/slack-bot` in this guide. Keep the
  `-*` after it: Secrets Manager appends a random suffix to a secret's ARN.
- **`<QUEUE_NAME>`.** Both policies name the **main** queue, `saturam-slack-bot-jobs` in this
  guide; `.fifo` is already in the template. The ingress sends to it and the worker consumes from
  it. Neither names the dead-letter queue. Queue names are case-sensitive.
- **`<TABLE_NAME>`.** The DynamoDB table from B1, `saturam-onboarding-conversations` in this guide.
- **`<KNOWLEDGE_BASE_ID>`, `<BUCKET_NAME>`, `<STATE_PREFIX>`.** From A3 and A2; the state prefix is
  `onboarding-state` with this guide's layout.
- **`<PROFILE_PREFIX>`.** The inference profile prefix from A1 step 4, `global` in `ap-south-1`.
  The worker policy names, for each of the two Claude models, its profile
  `<PROFILE_PREFIX>.<model id>` in your region and account, and the model itself both in every
  region (`arn:aws:bedrock:*::foundation-model/…`) and in the regionless form a global profile
  resolves to (`arn:aws:bedrock:::foundation-model/…`), because the profile may route the call
  anywhere. The model IDs themselves are not placeholders: they must match what the CLI knows
  (`LLMModel`), and listing both is what makes switching a variable-only change (B7).
- **Names you changed.** Whatever you put here must also be what the Lambda environment variables
  name (B7, B8). A mismatch shows up in the logs as _… is not authorized to perform: …_, not when
  you save the policy.

**Check:** `grep -n '<' deploy/slack-bot/iam/*.local.json` prints nothing once every placeholder
is filled in. The templates themselves are covered by a test (`tests/deploy/`) that fails if a
real account ID or region is ever written into them.

### Worker role

1. **IAM → Roles → Create role** → _AWS service_ → _Lambda_ → **Next**.
2. Tick **AWSLambdaBasicExecutionRole** (CloudWatch Logs) → **Next**.
3. **Role name:** `saturam-slack-bot-worker-role` → **Create role**.
4. Open the role → **Add permissions → Create inline policy → JSON**. Paste your filled-in
   `worker-policy.local.json` → **Next** → name `saturam-slack-bot-worker` → **Create policy**.

### Ingress role

The ingress gets a **second, separate role**. Don't reuse the worker role: the point of two roles is
that the ingress has fewer permissions.

1. **IAM → Roles → Create role** → _AWS service_ → _Lambda_ → **Next**.
2. Tick **AWSLambdaBasicExecutionRole** → **Next**.
3. **Role name:** `saturam-slack-bot-ingress-role` → **Create role**.
4. Open the role → **Add permissions → Create inline policy → JSON**. Replace the editor's contents
   with your filled-in `ingress-policy.local.json` → **Next** → name `saturam-slack-bot-ingress` →
   **Create policy**.

The ingress deliberately can't read the knowledge base, S3 or conversations, or invoke the model.
It reads the Slack secret, records deliveries it has handled, and sends jobs.

### Result

| Role                             | Inline policy               | Pasted from           | Chosen as the execution role of  |
| -------------------------------- | --------------------------- | --------------------- | -------------------------------- |
| `saturam-slack-bot-worker-role`  | `saturam-slack-bot-worker`  | `worker-policy.json`  | `saturam-slack-bot-worker` (B7)  |
| `saturam-slack-bot-ingress-role` | `saturam-slack-bot-ingress` | `ingress-policy.json` | `saturam-slack-bot-ingress` (B8) |

The policy files don't name the roles, so nothing in them changes. A role is connected to its
function when you create the function, under _Use an existing role_.

**Check:** each role's **Permissions** tab lists two policies, `AWSLambdaBasicExecutionRole` (AWS
managed) and its inline policy. Open the inline policy and compare it with the file: what's saved
in AWS is what counts. A worker role missing its secrets statement is a common cause of a
placeholder that never changes.

**Changing a policy later.** Editing the JSON file doesn't change AWS. Open the role → the inline
policy → **Edit** → replace the JSON → **Save changes**.

## B7. Worker Lambda

1. **Lambda → Create function → Author from scratch:**
    - **Function name:** `saturam-slack-bot-worker`
    - **Runtime:** **Node.js 22.x**
    - **Architecture:** **arm64**. The package is plain JavaScript, and arm64 costs about 20% less.
    - **Permissions → Change default execution role → Use an existing role →**
      `saturam-slack-bot-worker-role`
    - **Create function.**
2. **Code** tab → **Upload from → .zip file** → choose `dist/slack-bot/slack-bot-lambda.zip` →
   **Save**.
3. **Code** tab, scroll to **Runtime settings → Edit** → **Handler:** `worker.handler` → **Save**.
   The default `index.handler` doesn't exist in the zip.
4. **Configuration → General configuration → Edit:** **Memory 1024 MB**, **Timeout 3 min 0 sec** →
   **Save**.
5. **Configuration → Environment variables → Edit**, and add:

    | Key                             | Value                                                                                                        |
    | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
    | `SLACK_SECRET_ID`               | `saturam/slack-bot`                                                                                          |
    | `SLACK_JOB_QUEUE_URL`           | the main queue URL (B4)                                                                                      |
    | `SLACK_WORKER_MAX_ATTEMPTS`     | `2`                                                                                                          |
    | `SATENG_MODEL`                  | `anthropic.claude-sonnet-4-6`, or `anthropic.claude-haiku-4-5-20251001-v1:0` — the bare `<MODEL_ID>` from A1 |
    | `SATENG_BEDROCK_PROFILE_PREFIX` | `global` — required in `ap-south-1`, see below                                                               |
    | `SATENG_KB_ID`                  | `<KNOWLEDGE_BASE_ID>`                                                                                        |
    | `SATENG_S3_BUCKET`              | `<BUCKET_NAME>`                                                                                              |
    | `SATENG_S3_PREFIX`              | `onboarding`                                                                                                 |
    | `SATENG_CONVERSATION_TABLE`     | `saturam-onboarding-conversations`                                                                           |
    | `SATENG_CONVERSATION_TTL_DAYS`  | `90`                                                                                                         |
    | `NODE_OPTIONS`                  | `--enable-source-maps` (stack traces point at the TypeScript source)                                         |
    | `LOG_LEVEL`                     | `info`                                                                                                       |
    - **`SLACK_JOB_QUEUE_URL`** is the **main** queue's URL: **SQS → Queues →
      `saturam-slack-bot-jobs.fifo` → Details → URL**. Not the dead-letter queue, and not the ARN.
      The ingress gets the same value (B8).
    - **`SATENG_CONVERSATION_TABLE`** is the name of the DynamoDB table from B1, as shown under
      **DynamoDB → Tables**. It must also be the table named in both IAM policies (B6), and the
      ingress gets the same value.

    Don't add `AWS_REGION` (Lambda sets it, and Bedrock is called in that region) or any AWS keys
    (the role provides them). There is no model key: the role invokes the model.

    `SATENG_MODEL` is required. Without it the worker falls back to the CLI's default model, which
    the Lambda build doesn't support. The worker logs an error saying so at cold start, and every
    answer fails.

    `SATENG_BEDROCK_PROFILE_PREFIX` = `global` is required in `ap-south-1`. Without it the bot
    builds the region's default profile (`ap-*` → `apac`, `eu-*` → `eu`, otherwise `us`), and
    `apac.anthropic.claude-sonnet-4-6` does not exist, so every answer fails with _The provided
    model identifier is invalid_. It must match the profiles named in the worker policy (B6). Leave
    it unset only in a region whose profile list (A1 step 4) shows the models under `apac.`.

    **Switching between Sonnet 4.6 and Haiku 4.5 later** is a change to `SATENG_MODEL` on the
    worker and nothing else: **Configuration → Environment variables → Edit** → the other ID →
    **Save**. Saving starts fresh instances, so the next question already uses the new model; no
    zip upload, and nothing on the ingress, which has no model settings at all. Both IDs are
    allowed by the worker policy (B6), and both use the `global` profile, so
    `SATENG_BEDROCK_PROFILE_PREFIX` stays as it is. One rule: use the **bare model ID**
    (`anthropic.…`), never the profile ID (`global.anthropic.…` is not recognised, and the worker
    falls back to a model the build doesn't support). Any other model must first be added to the
    policy, and be one the CLI knows (`LLMModel` in `src/constants/llm-models.ts`).

    **Save.**

6. **Add the SQS trigger.** This connects the main queue to the worker: each question the ingress
   queues starts the worker.

    **First check two settings**, or AWS refuses the trigger: the worker's **Timeout** is **3 min**
    (step 4), and the main queue's **Visibility timeout** is **4 minutes** (B4). The queue's must be
    the longer of the two.
    1. At the top of the function page, in **Function overview**, click **+ Add trigger** (or
       **Configuration → Triggers → Add trigger**).
    2. **Select a source:** type `SQS` → choose **SQS**. The form fills in with the SQS settings.
    3. Fill in the form:

        | Field                          | Value                                                                         | Why                                                                                                                                                                                                                                                                                               |
        | ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
        | **SQS queue**                  | `saturam-slack-bot-jobs.fifo` from the dropdown (shown as an ARN). Not `-dlq` | The queue the ingress sends questions to                                                                                                                                                                                                                                                          |
        | **Activate trigger**           | ticked                                                                        | Otherwise the trigger is created switched off, and questions wait in the queue                                                                                                                                                                                                                    |
        | **Batch size**                 | `1` (the default is 10)                                                       | One question per run, so a slow answer never holds up others                                                                                                                                                                                                                                      |
        | **Batch window** (if shown)    | empty                                                                         | FIFO queues don't use it                                                                                                                                                                                                                                                                          |
        | **Maximum concurrency**        | `5`                                                                           | Caps simultaneous answers, and so the load on the model's tokens-per-minute quota in Bedrock and your cost. Each answer makes several model calls: an agent loop of up to 6 search-and-write rounds, plus the follow-up suggestions, a one-line gist, and every fifth turn a conversation summary |
        | **Filter criteria** (if shown) | empty                                                                         | A filter would silently drop questions                                                                                                                                                                                                                                                            |

    4. Expand **Additional settings** → tick **Report batch item failures**. This is required. The
       worker reports each failed question itself; without this setting Lambda ignores that, deletes
       the failed question instead of retrying it, and the user never gets the apology.
    5. **Add.**

    **Check:** **Configuration → Triggers** lists the queue with **State: Enabled**. It can show
    _Creating_ for a minute; refresh. Open the trigger to confirm batch size 1, maximum concurrency 5
    and _Report batch item failures: Yes_. The diagram at the top now shows **SQS** feeding the
    worker.

    | If **Add** fails with                                                          | Fix                                                                                                    |
    | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
    | _The provided execution role does not have permissions to call ReceiveMessage_ | The worker role lacks `worker-policy.json`, or its SQS ARN doesn't match the queue name exactly (B6)   |
    | _Queue visibility timeout … is less than Function timeout_                     | **SQS →** the main queue **→ Edit → Visibility timeout: 4 minutes → Save**, then add the trigger again |
    | The queue isn't in the dropdown                                                | Wrong region: the queue and the function must be in the same one                                       |

## B8. Ingress Lambda

1. **Lambda → Create function → Author from scratch:** name `saturam-slack-bot-ingress`, runtime
   **Node.js 22.x**, **arm64**, existing role `saturam-slack-bot-ingress-role` → **Create
   function**.
2. **Code → Upload from → .zip file** → the **same** zip → **Save**.
3. **Runtime settings → Edit → Handler:** `ingress.handler` → **Save**.
4. **General configuration:** **Memory 512 MB**, **Timeout 15 sec** → **Save**.
5. **Environment variables:**

    | Key                         | Value                              |
    | --------------------------- | ---------------------------------- |
    | `SLACK_SECRET_ID`           | `saturam/slack-bot`                |
    | `SLACK_JOB_QUEUE_URL`       | the main queue URL, same as B7     |
    | `SATENG_CONVERSATION_TABLE` | `saturam-onboarding-conversations` |
    | `NODE_OPTIONS`              | `--enable-source-maps`             |
    | `LOG_LEVEL`                 | `info`                             |

    Optional access control (comma-separated; empty means no restriction):

    | Key                           | Effect                                                                                                                                                   |
    | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `SLACK_ALLOWED_TEAM_IDS`      | Answer only in these workspaces                                                                                                                          |
    | `SLACK_ALLOWED_CHANNEL_IDS`   | Answer @mentions only in these channels (channel → _About_ → ID at the bottom). Elsewhere the user gets a private _I'm not enabled in this channel_ note |
    | `SLACK_ALLOW_DIRECT_MESSAGES` | `false` turns DMs off                                                                                                                                    |

    Leave all three out for the first test; nothing is restricted then. Only the ingress reads
    them, and a change takes effect on the next message.

    **To test in one channel only** (a private channel works; the three bot scopes cover it once
    the bot is a member):
    1. Invite the bot to the channel (B11, step 1).
    2. Click the channel name → **About** → copy the **Channel ID** at the bottom (`C…`; older
       private channels start with `G`).
    3. Set `SLACK_ALLOWED_CHANNEL_IDS` to it. Add `SLACK_ALLOW_DIRECT_MESSAGES` = `false` too if DMs
       shouldn't work yet.

    To lift the restriction later, remove the variable, or add more IDs separated by commas.

6. **Smoke test.** **Test** tab → new event `unsigned` with body
   `{ "body": "{}", "headers": {} }` → **Test**.
    - **Expected:** `"statusCode": 401`, with the log line _Rejected a request with a missing, stale
      or invalid Slack signature_. That proves the handler is set correctly and the function can
      read the secret.
    - A `500` with _AccessDeniedException … not authorized to perform:
      secretsmanager:GetSecretValue_ means the secret ARN in the ingress policy is wrong, or the
      policy isn't attached to the role.
    - _Cannot find module 'index'_ means the handler wasn't changed (step 3).

## B9. API Gateway (HTTP API)

1. **API Gateway → Create API → HTTP API → Build.**
2. **Add integration → Lambda** → `saturam-slack-bot-ingress`. **API name:**
   `saturam-slack-bot-api` → **Next**.
3. **Routes:** **Method `POST`**, **Resource path `/slack/events`**, target the ingress → **Next**.
4. **Stages:** `$default`, **Auto-deploy** on → **Next → Create**.
5. **Copy the Invoke URL.** **APIs →** `saturam-slack-bot-api`. The API's page has a **Stages**
   table: copy the **Invoke URL** in the `$default` row (or **Deploy → Stages → `$default` → Stage
   details**). It looks like `https://abc123xyz.execute-api.<REGION>.amazonaws.com`, with no stage
   name at the end because the stage is `$default`.

    Slack will call **`<Invoke URL>/slack/events`**. If the copied URL ends in `/`, don't double
    it: `…amazonaws.com/slack/events`. Note this full URL; B10 needs it.

6. **Protect → Throttling → Default route throttling → Edit** → **Burst limit 100, Rate limit 50**
   → **Save**.

Check from a terminal:

```bash
curl -i -X POST "<Invoke URL>/slack/events" -d '{}'
```

| Result                                        | Meaning                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **`401`**                                     | Correct: the request reached the ingress and was rejected because Slack didn't sign it       |
| `404` / `{"message":"Not Found"}`             | Wrong path or method; the route must be exactly `POST /slack/events`                         |
| `500` / `{"message":"Internal Server Error"}` | The ingress failed; see its log in CloudWatch (usually the secret or the handler, B8 step 6) |

Opening the URL in a browser shows _Not Found_. That's expected: a browser sends `GET`, and the
only route is `POST`.

## B10. Slack app — second pass (events and interactivity)

At <https://api.slack.com/apps> → your app:

1. **Event Subscriptions → Enable Events: On**
    - **Request URL:** `<Invoke URL>/slack/events`. Slack should show **Verified ✓**.
    - **Subscribe to bot events → Add Bot User Event:** `app_mention` and `message.im`. The table
      shows each event's required scope (`app_mentions:read`, `im:history`); both are already
      granted from B2.
    - **Save Changes.**
2. **Interactivity & Shortcuts → On** → **Request URL:** the same URL → **Save Changes.** This URL
   receives the follow-up and feedback button clicks.
3. **App Home → Show Tabs:** check that **Messages Tab** is on and **Allow users to send Slash
   commands and messages from the messages tab** is ticked. B2's manifest sets both.
4. If Slack shows a banner asking you to **reinstall your app**, do it. The token doesn't change.

**Or do all of this in one paste:** **App Manifest → YAML** → replace it with
[`deploy/slack-bot/slack-app-manifest.yaml`](../deploy/slack-bot/slack-app-manifest.yaml), with
both `<API_GATEWAY_URL>` placeholders replaced by your Invoke URL → **Save Changes**. Slack verifies
the URL as part of saving.

## B11. End-to-end test

These questions are answerable from the sample corpus:

1. In a channel, `/invite @onboarding` (or channel name → **Integrations → Add apps**). A private
   channel works the same way, but the bot sees nothing there until it's invited. If you set
   `SLACK_ALLOWED_CHANNEL_IDS` (B8), use that channel. Then:
   `@onboarding how does the Slack bot answer a question?`
    - Within a second, a threaded reply appears: _Searching the knowledge base…_
    - Within about 10–40 s it becomes the answer, with the project _sat-cli_, sources linking to
      the two sample pages, follow-up buttons and 👍/👎.
2. Reply in the thread: `@onboarding what happens if it fails?` The answer follows on from the
   first one.
3. Click a follow-up button, then 👍 (a private _Thanks_ appears).
4. DM the bot: `how do I install sat-cli?`
5. Check the logs in **CloudWatch → Log groups**:
    - the ingress group shows `Queued event:Ev… (mention)`;
    - the worker group shows
      `Answered event:Ev… in …ms (attempt 1/2, … chunk(s), project saturam-cli)`.
6. **DynamoDB → Explore items** shows `slack#T…#U…` (history), `slack-event#…` (deliveries) and
   `slack-feedback#T…` items.

If the answer says the documentation doesn't cover it and `project none` is logged, the knowledge
base returned nothing. Go back to A4.

If the placeholder never changes, or you get _Sorry — I couldn't answer that just now_, follow
[Finding where a question got stuck](#finding-where-a-question-got-stuck).

## B12. Log retention and alarms

**Retention.** For `/aws/lambda/saturam-slack-bot-ingress` and `/aws/lambda/saturam-slack-bot-worker`:
**CloudWatch → Log groups → Actions → Edit retention setting → 30 days**. The default keeps logs
forever.

**Topic.** **SNS → Topics → Create topic** → _Standard_ → `saturam-slack-bot-alarms`. Then
**Create subscription** → _Email_ → any address (your Gmail works), and confirm it from your inbox.

**Alarms.** **CloudWatch → Alarms → Create alarm → Select metric**, then notify
`saturam-slack-bot-alarms` for each:

| Alarm          | Metric                                                                       | Statistic / period | Condition | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------- | ------------------ | --------- | ---------------------------------------------------------------------------------- |
| Dead letters   | SQS `saturam-slack-bot-jobs-dlq.fifo` → `ApproximateNumberOfMessagesVisible` | Max / 5 min        | ≥ 1       | A job failed every attempt, or was malformed                                       |
| Stuck queue    | SQS `saturam-slack-bot-jobs.fifo` → `ApproximateAgeOfOldestMessage`          | Max / 5 min        | ≥ 300     | Questions waiting more than 5 min: the trigger is off, or the worker keeps failing |
| Ingress errors | Lambda `saturam-slack-bot-ingress` → `Errors`                                | Sum / 5 min        | ≥ 1       | The front door is crashing                                                         |
| Slow answers   | Lambda `saturam-slack-bot-worker` → `Duration`                               | p95 / 15 min       | ≥ 120000  | Answers are nearing the 3-minute timeout                                           |
| Gateway 5xx    | ApiGateway `saturam-slack-bot-api` → `5xx`                                   | Sum / 5 min        | ≥ 5       | Slack is getting errors                                                            |

For the two SQS alarms, set **Missing data treatment → Treat missing data as good**.

---

# Part C — Operating

## Deploying a code change

Build the zip on your machine, from the repository root:

```bash
pnpm install
pnpm slack:bundle          # → dist/slack-bot/slack-bot-lambda.zip
```

Then upload it to **both** functions. In the console: **Lambda → the function → Code → Upload from
→ .zip file** → the zip → **Save**, for `saturam-slack-bot-worker` and then
`saturam-slack-bot-ingress`; the handler setting is kept. Or from the terminal, with the AWS CLI
signed in to the account:

```bash
aws lambda update-function-code --function-name saturam-slack-bot-worker \
    --zip-file fileb://dist/slack-bot/slack-bot-lambda.zip --region <REGION>
aws lambda update-function-code --function-name saturam-slack-bot-ingress \
    --zip-file fileb://dist/slack-bot/slack-bot-lambda.zip --region <REGION>
```

Always deploy the same zip to both functions. They share the job format on the queue, and a
mismatch sends jobs to the dead-letter queue. To roll back, keep the previous zip and upload it to
both.

Changing documents needs no deploy: update S3 and sync (or let the ingestion pipeline do it). A new
project appears in the bot within 10 minutes of `registry.json` changing.

## Rotating credentials

| What         | How                                                                   |
| ------------ | --------------------------------------------------------------------- |
| Slack tokens | Update `saturam/slack-bot` → force a cold start of **both** functions |

The model has no credentials to rotate: the worker calls Bedrock with its IAM role.

Each function reads its secrets once per cold start, so a changed value, or a renamed or added
key, takes effect only after one.

**Forcing a cold start:** Lambda → the function → **Configuration → Environment variables → Edit**
→ change any value (e.g. `LOG_LEVEL` to `debug`) → **Save**. Every saved configuration change
starts fresh instances.

A secret the function **couldn't** read is different: a failed read is tried again on the next
message, so after fixing an IAM policy no cold start is needed. Allow about a minute for the IAM
change to apply.

## Local development (Socket Mode)

Socket Mode runs the whole bot on your machine without API Gateway or a queue. Slack pushes events
down a WebSocket.

1. Create a **separate** development Slack app. Don't reuse the production app: Socket Mode turns
   off its HTTP delivery.
    - Create it from `deploy/slack-bot/slack-app-manifest.yaml`, with `socket_mode_enabled: true`
      and the `request_url` lines removed.
    - **Basic Information → App-Level Tokens → Generate** with scope `connections:write` → copy the
      `xapp-…` token.
    - **Install to Workspace** → copy the `xoxb-…` token.
2. Create a `.env` file at the repository root (it's git-ignored):

    ```bash
    SLACK_APP_TOKEN=xapp-...
    SLACK_BOT_TOKEN=xoxb-...
    SATENG_MODEL=anthropic.claude-sonnet-4-6
    SATENG_BEDROCK_PROFILE_PREFIX=global     # ap-south-1 offers these models only as global.*
    SATENG_KB_ID=<KNOWLEDGE_BASE_ID>
    SATENG_S3_BUCKET=<BUCKET_NAME>
    SATENG_S3_PREFIX=onboarding
    # SATENG_CONVERSATION_TABLE=saturam-onboarding-conversations   # optional; otherwise in-memory
    # A profile allowed to call bedrock:InvokeModel and bedrock:Retrieve, and to read the bucket
    AWS_PROFILE=<your profile>
    AWS_REGION=<REGION>
    ```

3. `pnpm slack:dev`, then mention or DM the development bot.

The terminal CLI can use the same model: `sat-cli init` → **AI / LLM providers** → **AWS Bedrock
(Claude, Nova)** → **Bedrock Claude 4.6 Sonnet**, with your profile and region, and
`SATENG_BEDROCK_PROFILE_PREFIX=global` exported in that shell for the same reason as B7.

## Configuration reference

**Lambda environment variables**

| Variable                                                                             | Function   | Required            | Meaning                                                                                                            |
| ------------------------------------------------------------------------------------ | ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SLACK_SECRET_ID`                                                                    | both       | yes                 | Secret holding `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`                                                        |
| `SLACK_JOB_QUEUE_URL`                                                                | both       | yes                 | FIFO queue URL                                                                                                     |
| `SATENG_CONVERSATION_TABLE`                                                          | both       | yes                 | History, delivery de-duplication, feedback                                                                         |
| `SLACK_WORKER_MAX_ATTEMPTS`                                                          | worker     | yes                 | Must equal the queue's _Maximum receives_ (default `2`)                                                            |
| `SATENG_MODEL`                                                                       | worker     | yes                 | Bare model ID: `anthropic.claude-sonnet-4-6` or `anthropic.claude-haiku-4-5-20251001-v1:0`; others in the Appendix |
| `SATENG_BEDROCK_PROFILE_PREFIX`                                                      | worker     | yes in `ap-south-1` | `global`: the only profile these models have there (A1). Unset elsewhere means the region's default prefix         |
| `SATENG_BEDROCK_REGION`                                                              | worker     | no                  | Only when the model is invoked outside the function's region                                                       |
| `SATENG_LLM_SECRET_ID`                                                               | worker     | no                  | Azure only (Appendix): secret holding the provider's credentials                                                   |
| `SATENG_KB_ID`                                                                       | worker     | yes                 | Knowledge Base ID                                                                                                  |
| `SATENG_S3_BUCKET`, `SATENG_S3_PREFIX`                                               | worker     | yes                 | Where `registry.json` is found (`<prefix>-state/registry.json`)                                                    |
| `SATENG_S3_STATE_PREFIX`                                                             | worker     | no                  | Overrides `<prefix>-state`                                                                                         |
| `SATENG_CONVERSATION_TTL_DAYS`                                                       | worker     | no                  | Default 90                                                                                                         |
| `SATENG_KB_REGION`, `SATENG_S3_REGION`, `SATENG_CONVERSATION_TABLE_REGION`           | as used    | no                  | Only when a resource is outside the function's region                                                              |
| `SLACK_ALLOWED_TEAM_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, `SLACK_ALLOW_DIRECT_MESSAGES` | ingress    | no                  | Access control                                                                                                     |
| `NODE_OPTIONS`, `LOG_LEVEL`                                                          | both       | no                  | `--enable-source-maps`; `info` or `debug`                                                                          |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`                         | local only | —                   | Never set these on Lambda                                                                                          |

**Secrets**

| Secret                  | Keys                                                              | Read by         |
| ----------------------- | ----------------------------------------------------------------- | --------------- |
| `saturam/slack-bot`     | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`                         | ingress, worker |
| `saturam/azure-foundry` | Azure only (Appendix): `AZURE_OPENAI_*` or `AZURE_FOUNDRY_*` keys | worker          |

## How conversations behave

- **A thread is a conversation.** Start a new thread to change the subject; this is the Slack
  equivalent of `--new-session`.
- **Each person's history carries across their threads.** A new thread starts with their last few
  turns as context. Two people in one thread each keep their own context.
- **In channels, mention the bot every time**, including in its own threads. It only receives
  messages that mention it.
- **In DMs, each top-level message starts a thread.** Reply in the thread to follow up; carried-over
  context connects top-level questions too.
- **Follow-up buttons** ask on behalf of whoever clicks, and the answer shows who asked.
- **Feedback.** 👍/👎 is stored per answer and per rater, and a second click replaces the first.
  Query `pk = slack-feedback#<team ID>` to read it.

## Security notes

- **Authentication.** Every request is authenticated by Slack's HMAC signature over the raw body,
  and anything older than 5 minutes is rejected. The ingress refuses to run without a signing
  secret rather than skip the check.
- **Least privilege.** The ingress can't read the knowledge base or conversations, or invoke the
  model, and neither role has AWS keys.
- **Secrets.** The Slack tokens live only in Secrets Manager. They are held in memory and never
  logged. The model needs no key: the worker's role invokes it.
- **Data stays in AWS.** To write an answer, the worker sends the user's question, recent
  conversation turns and the retrieved document excerpts to Bedrock. The cross-region inference
  profile may process the request in another region of the same geography, but the data never
  leaves AWS.
- **Who sees what.** Anyone who can DM the bot, or mention it in an allowed channel, can ask about
  **every** indexed project. If that's too broad, restrict channels, turn DMs off, or split the
  knowledge base.
- **Answer screening.** Answers pass the CLI's guards: credential-shaped text is redacted, and
  identifiers the sources never mention are revised away. Errors shown in Slack carry a reference
  ID, never internals.
- **Logs.** At `LOG_LEVEL` `info` they record IDs, timings and outcomes, not questions or answers;
  the one exception is a failed knowledge-base search, which logs its query as a warning. At
  `debug`, every search query the agent runs is logged too, so switch back to `info` after
  troubleshooting if that matters for the documentation you index.

## Troubleshooting

| Symptom                                                                                                                                 | Likely cause                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack: _URL didn't respond with the value of the challenge parameter_                                                                   | Wrong URL, the ingress can't read the secret, or the signing secret doesn't match                                                                                                                              | B8 smoke test. The URL must end in `/slack/events`. Compare Slack's Signing Secret with the secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Lambda test: _Cannot find module 'index'_                                                                                               | Handler not set                                                                                                                                                                                                | Runtime settings → `worker.handler` / `ingress.handler`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Mentions get no reply                                                                                                                   | Events not subscribed, bot not in the channel, or channel not allow-listed                                                                                                                                     | B10.1, `/invite @onboarding`, `SLACK_ALLOWED_CHANNEL_IDS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| DMs: _Sending messages to this app has been turned off_                                                                                 | Messages tab off                                                                                                                                                                                               | B10.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Placeholder never changes                                                                                                               | The worker never ran, was killed, or can't read the Slack secret to post                                                                                                                                       | [Finding where a question got stuck](#finding-where-a-question-got-stuck)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ingress log: _Could not queue event:Ev…: … not authorized to perform: sqs:SendMessage_                                                  | The ingress policy names another queue (e.g. the dead-letter queue, or wrong case)                                                                                                                             | B6: the main queue, `saturam-slack-bot-jobs.fifo`, lowercase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| _Sorry — I couldn't answer that just now_ + a reference                                                                                 | Every attempt failed                                                                                                                                                                                           | Search the worker logs for the reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Worker log: _not supported by the Slack bot's Lambda build_                                                                             | `SATENG_MODEL` missing or wrong                                                                                                                                                                                | B7.5: `anthropic.claude-sonnet-4-6` or `anthropic.claude-haiku-4-5-20251001-v1:0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Worker log: _Unrecognized saved model ID "global.anthropic…"_, then _not supported by the Slack bot's Lambda build_                     | `SATENG_MODEL` holds the inference profile ID instead of the model ID                                                                                                                                          | B7: the bare ID, `anthropic.…`; the profile prefix goes in `SATENG_BEDROCK_PROFILE_PREFIX`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Worker log: _Could not replace the placeholder_ / _Could not show the retry notice_ … _not authorized … on resource: saturam/slack-bot_ | The worker role's policy **as saved in AWS** doesn't allow the secret, or no secret has exactly that name, so the worker can't post anything                                                                   | IAM → worker role → inline policy → **Edit** → replace it with your filled-in `worker-policy.local.json` (B6). Check the secret's name in Secrets Manager: a missing secret also shows as _not authorized_. No cold start needed                                                                                                                                                                                                                                                                                                                                                                              |
| Worker log: _AccessDeniedException_ … _not authorized to perform: bedrock:InvokeModel on resource: … inference-profile/…_               | The worker policy's model statement names a different profile or model than the one being called                                                                                                               | B6: the profile ARN must be `<PROFILE_PREFIX>.<MODEL_ID>` exactly as A1 shows it, in your region and account, plus the `foundation-model` ARN. `SATENG_BEDROCK_PROFILE_PREFIX` (B7), if set, must match                                                                                                                                                                                                                                                                                                                                                                                                       |
| Worker log: _AccessDeniedException: You don't have access to the model with the specified model ID_                                     | Model access not granted in this region                                                                                                                                                                        | A1: enable Claude Sonnet 4.6 and wait for _Access granted_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Worker log: _ValidationException_ … _The provided model identifier is invalid_ / _inference profile … not found_                        | The profile ID the bot built (`<prefix>.<SATENG_MODEL>`, shown by the _Bedrock: invoking …_ debug line) doesn't exist in the region it called. Not a permission problem: that would be _AccessDeniedException_ | `aws bedrock list-inference-profiles --region <REGION>` shows the real IDs. If the model is there under another prefix (e.g. `global`), set `SATENG_BEDROCK_PROFILE_PREFIX` to it (B7) and fix the profile ARN in the policy (B6). If it exists only in another geography (only `us.`/`eu.` profiles), set `SATENG_BEDROCK_REGION` to a region there, e.g. `us-east-1` (the prefix follows it), and use that region and prefix in the policy's profile ARN; the data then leaves your geography. If the model ID itself isn't listed by `list-foundation-models`, it's wrong or not offered: see the Appendix |
| Worker log: _ThrottlingException_ / _Too many requests_                                                                                 | The model's tokens- or requests-per-minute quota is exceeded                                                                                                                                                   | Lower the trigger's _Maximum concurrency_, or request a quota increase (**Service Quotas → Amazon Bedrock**)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Worker log: `ENOTFOUND` / timeout to `bedrock-runtime.<region>.amazonaws.com` or `slack.com`                                            | Lambda has no internet route                                                                                                                                                                                   | Remove the function from any VPC (or add a NAT gateway / VPC endpoints)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Worker log: _not authorized to perform: bedrock:Retrieve_                                                                               | Wrong KB ID or region in the policy                                                                                                                                                                            | B6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Answers say nothing is documented                                                                                                       | Knowledge base empty or not synced                                                                                                                                                                             | A3.6, A4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Answers never name a project; `project none` in the logs                                                                                | `registry.json` not read                                                                                                                                                                                       | `SATENG_S3_BUCKET`/`SATENG_S3_PREFIX`, the file at `onboarding-state/registry.json`, and the S3 ARN in the worker policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Project-scoped searches return nothing                                                                                                  | Metadata `project` ≠ registry `slug`, or metadata files misnamed                                                                                                                                               | A2 layout rules, re-sync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Occasional duplicate answer                                                                                                             | De-duplication table unreachable (the bot errs towards answering)                                                                                                                                              | Ingress `SATENG_CONVERSATION_TABLE` and its `dynamodb:PutItem` permission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Slow first reply after a quiet period                                                                                                   | Cold start                                                                                                                                                                                                     | Harmless (Slack's retry is de-duplicated). To remove it, publish an ingress version, add an alias with provisioned concurrency 1, and point the API integration at the alias                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Finding where a question got stuck

Start with what the Slack thread shows:

| Slack shows                                                                  | Meaning                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No placeholder at all                                                        | Slack never reached the ingress, or the ingress ignored the message: see _Mentions get no reply_ above             |
| _Searching the knowledge base…_ that never changes                           | The question was queued, but the worker never ran, was killed (timeout), or couldn't read the Slack secret to post |
| _Still working…_, then _Sorry — I couldn't answer that just now_ + reference | The worker ran and failed on both attempts. Search its log for the reference (step 5)                              |
| _Sorry — I couldn't answer that just now_ immediately                        | The ingress couldn't queue the question (step 1)                                                                   |

Then check each stage in order, in the bot's region. Stop at the first one that's wrong.

1. **Ingress log.** **CloudWatch → Log groups → `/aws/lambda/saturam-slack-bot-ingress`** → the
   newest log stream.
    - `Queued event:Ev… (mention) in C…/…`: the question is on the queue. Go on.
    - `Could not queue event:Ev…: …`: the ingress policy or its `SLACK_JOB_QUEUE_URL` (B6, B8).
2. **The queues.** **SQS → Queues** → refresh, then read **Messages available** and **Messages in
   flight** for both queues. Don't use **Poll for messages** on the main queue: it counts as a
   delivery attempt and can push the question into the dead-letter queue.

    | You see                                                         | Meaning                                                                                        |
    | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
    | Main queue: available ≥ 1                                       | Nothing is reading the queue: step 3                                                           |
    | Main queue: in flight ≥ 1                                       | The worker has it, or was killed and SQS retries after the 4-minute visibility timeout         |
    | Dead-letter queue: available ≥ 1, and the worker has never run  | The ingress sends to the dead-letter queue: its `SLACK_JOB_QUEUE_URL` must be the main queue's |
    | Dead-letter queue: available ≥ 1, and the worker log has errors | The worker failed on every attempt: step 5                                                     |

3. **The trigger.** **Lambda → `saturam-slack-bot-worker` → Configuration → Triggers**: one SQS
   trigger on `saturam-slack-bot-jobs.fifo`, **State: Enabled** (B7 step 6).
4. **Did the worker run?** Worker → **Monitor**, time range covering the question. **Invocations**
   of 0 means steps 1–3. A failed answer doesn't show under **Errors**: the worker reports failed
   questions to SQS itself and ends normally, so read its log either way.
5. **Worker log.** Worker → **Monitor → View CloudWatch logs** → the newest log stream:

    | Line                                                       | Cause and fix                                                                  |
    | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
    | _Task timed out after 3.00 seconds_                        | Timeout left at the default: B7 step 4, **3 min 0 sec**                        |
    | _Task timed out after 180.00 seconds_                      | Something hangs, usually no internet: **Configuration → VPC** must show no VPC |
    | _Runtime.ImportModuleError_ / _Cannot find module 'index'_ | Handler: B7 step 3, `worker.handler`                                           |
    | _Answering event:Ev… failed on attempt n/2_ + an error     | The error names the cause; find it in the table above                          |
    | _Could not replace the placeholder …_                      | The worker can't post to Slack: its Slack secret access or `SLACK_SECRET_ID`   |

After a fix, ask a **new** question. A question that already failed isn't retried, and its
placeholder can be deleted.

## Removing everything

Delete in this order, so nothing is left calling something already gone:

1. The Slack app.
2. The API Gateway API.
3. Both Lambdas.
4. Both queues.
5. The secret.
6. The DynamoDB table.
7. Both IAM roles.
8. The CloudWatch alarms, SNS topic and log groups.
9. The knowledge base (its data source is deleted with it). Then the S3 vector bucket the quick
   create made: find it under **S3 → Vector buckets**.
10. The documents bucket (empty it first).
11. The knowledge base's service role (IAM, `AmazonBedrockExecutionRoleForKnowledgeBase_…`).

---

# Appendix — other model providers

The Lambda build also carries clients for Azure AI Foundry, for Claude or for a GPT deployment.
Switching is configuration only; no code change or rebuild is needed.

### Another Claude model on Bedrock

Sonnet 4.6 and Haiku 4.5 are already set up, and switching between them is B7's variable change.
For any other model:

1. It must be one the CLI knows: the `LLMModel` enum in `src/constants/llm-models.ts`, with an
   entry in `MODEL_CONTEXT_WINDOWS`, the `BEDROCK_MODELS` set, `PROVIDER_MODELS` in
   `config-service.ts` and `MODEL_DISPLAY_NAMES` in `init-command.ts`. An unknown ID in
   `SATENG_MODEL` is ignored with a warning, and the worker falls back to an unsupported default.
   After adding one, rebuild and upload the zip (Part C).
2. Enable it in A1 and note its inference profile ID.
3. Add its two ARNs to the worker policy's `InvokeModelThroughCrossRegionProfile` statement (B6),
   then save the policy in IAM.
4. On the worker, set `SATENG_MODEL` to its `<MODEL_ID>` (the part after the profile prefix), and
   `SATENG_BEDROCK_PROFILE_PREFIX` if the prefix differs from the region's default.

### Azure AI Foundry — common steps

Both Azure options keep their credentials in a second secret, which only the worker reads.

1. **Secrets Manager → Store a new secret → Other type of secret**, name `saturam/azure-foundry`,
   with the keys listed under the option you choose below. Values are never logged; the worker log
   names only the keys it loaded.
2. Add the secret to the worker policy's `ReadSlackSecret` statement (B6), so its `Resource` becomes
   a list, and save the policy in IAM:

    ```json
    "Resource": [
        "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:saturam/slack-bot-*",
        "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:saturam/azure-foundry-*"
    ]
    ```

3. On the worker, add `SATENG_LLM_SECRET_ID` = `saturam/azure-foundry`, set `SATENG_MODEL` as below,
   and force a cold start ([Rotating credentials](#rotating-credentials)). The worker log then shows
   `Loaded model credentials from saturam/azure-foundry: …` once per cold start.
4. The worker must reach `*.azure.com` over the internet, so it stays outside any VPC. Data now
   leaves AWS: the question, recent turns and retrieved excerpts go to your Azure deployment.

The `InvokeModelThroughCrossRegionProfile` statement can stay in the policy; it is simply unused.

To rotate an Azure key: regenerate it in Foundry, update it in the secret, and force a worker cold
start. Azure keeps two keys, so switch to the second before regenerating the first.

### Claude on Azure AI Foundry

1. In Foundry, open the Claude deployment. Note its **deployment name** (e.g. `claude-sonnet-4-5`),
   its **Target URI** (e.g. `https://my-res.services.ai.azure.com/anthropic/v1/messages`; paste it as
   is) and a **key**.
2. Secret keys:

    | Key                        | Value                                |
    | -------------------------- | ------------------------------------ |
    | `AZURE_FOUNDRY_API_KEY`    | the key                              |
    | `AZURE_FOUNDRY_ENDPOINT`   | the Target URI (or the resource URL) |
    | `AZURE_FOUNDRY_DEPLOYMENT` | the deployment name                  |

3. `SATENG_MODEL` = `azure-foundry-claude`.

### A GPT deployment on Azure AI Foundry / Azure OpenAI

1. In Foundry, open the deployment (e.g. `gpt-5.4-mini`). Note its **deployment name**, its
   **Target URI** (e.g.
   `https://my-res.cognitiveservices.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-04-01-preview`;
   paste it as is — the bot takes the resource URL, deployment name and `api-version` from it) and a
   **key**.
2. Secret keys:

    | Key                            | Value                                          | Required                                                 |
    | ------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
    | `AZURE_OPENAI_API_KEY`         | the key                                        | yes                                                      |
    | `AZURE_OPENAI_ENDPOINT`        | the full Target URI (or just the resource URL) | yes                                                      |
    | `AZURE_OPENAI_DEPLOYMENT_NAME` | the deployment name                            | yes                                                      |
    | `AZURE_OPENAI_API_VERSION`     | the `api-version` from the Target URI          | only if `AZURE_OPENAI_ENDPOINT` is just the resource URL |

3. `SATENG_MODEL` = `azure-openai-custom`.

GPT-5-family and o-series models accept only their default temperature, so the bot leaves it out
for any deployment whose name starts with `gpt-5` or `o<digit>`. If your deployment name hides the
model (e.g. `onboarding-bot`), also add `AZURE_OPENAI_SUPPORTS_TEMPERATURE` = `false` to the secret.

Use the `AZURE_OPENAI_*` key names for a GPT deployment and `AZURE_FOUNDRY_*` for Claude: with the
wrong set the worker loads them but never uses them, and every answer fails with _No API key found_.
Other Azure errors in the worker log: `401` _invalid subscription key_ (key and endpoint from
different resources), `404` _DeploymentNotFound_ (wrong deployment name, or the endpoint of another
resource), `429` (the deployment's quota; lower _Maximum concurrency_ or raise it in Foundry), and
_unsupported api-version_ (paste the full Target URI as `AZURE_OPENAI_ENDPOINT`).
