# Lumos Project Documentation Standard

_The document set every project keeps, whatever kind of project it is, and the prompt that produces it_

Version 1.1 · 15 October 2026 · AI-COE Team, Saturam · Applies to every repository indexed by Lumos

---

## 1. Purpose

Lumos answers engineers' questions from two things: the source code it indexes from Bitbucket, and the documents written about each project. The code says what the system does. Only the documents say why, how the parts fit, what a change touches, and who to ask. This standard fixes the shape of those documents so that every project, of every kind, produces the same set in the same place with the same structure, and so that Lumos can connect each document to the code it describes.

It is written for two readers. An engineer who owns a repository uses it to know what to write and to review what was written. An AI assistant, run in a repository with the prompt in section 11, uses it to produce or refresh the whole set from the code. The result in both cases is a folder `docs/onboarding/` in the repository, on the branch Lumos indexes, holding the files that apply to that project's profiles.

Projects differ. A backend service has endpoints and workers; a data pipeline has jobs and tables; a mobile app has screens; an infrastructure repository has cloud resources; a library has a public API and a release process. The standard handles this with profiles (section 3): a fixed catalogue of documents, each marked as required, conditional or not applicable per profile. A project declares its profiles once and writes only what applies. File names and numbers are stable across all projects, so a question about configuration finds `16-configuration.md` in every one of them.

## 2. How Lumos uses these documents

A document set lives in the repository under `docs/onboarding/`. The Lumos pipeline reads the branch named in the onboarding sheet, writes every Markdown file it finds to S3 with a metadata sidecar, and the Bedrock Knowledge Base indexes it beside the source files. The mentor in `sat-cli lumos` and the Slack bot then retrieve from both, read whole documents when a passage is not enough, and cite paths. A set kept in Google Drive is indexed the same way, but a set in the repository is versioned with the code it describes and reviewed in the same pull request, which is why the repository is the preferred home.

Lumos relies on the following, and the rest of this standard exists to guarantee them:

| What Lumos relies on                                                                                                                     | Why                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The folder `docs/onboarding/` and the file names in section 4                                                                            | Retrieval and the repository index find a project's documents without guessing; the same question finds the same document in every project         |
| The YAML front matter in section 5, with `project`, `profiles`, `code_paths`, `tables`, `jobs`, `apis`, `events`, `configs`, `resources` | These become the links from a document to the code, data, jobs and infrastructure it describes, which is what makes change-impact answers possible |
| A "Related code" section at the end of every document                                                                                    | A second, human-readable copy of the same links, which the identifier guard uses to accept paths the document names                                |
| `25-change-impact-map.md` with one row per entity                                                                                        | The first thing the mentor reads for "what will this change affect"                                                                                |
| `23-making-changes.md` with one recipe per common change                                                                                 | The pattern the mentor copies when asked to plan a change, including a new feature                                                                 |
| `21-open-questions.md` and `owners` in every front matter                                                                                | What the mentor says when it does not know, and whom it points to                                                                                  |
| No secret value anywhere                                                                                                                 | Documents are read by everyone who can query Lumos; the pipeline redacts what it recognises, and it does not recognise everything                  |

## 3. Project profiles

A profile is a kind of project. A repository has one or more; a monorepo lists every profile it contains. The profiles are declared in `00-overview.md` and in the `profiles` field of every document's front matter, and they decide which documents the project writes (section 4) and which entity kinds its impact map tracks (section 8).

| Profile      | What it means                                              | Typical contents                                                               |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `service`    | A backend service or API                                   | HTTP or RPC endpoints, handlers, workers, a database, outbound calls           |
| `web`        | A browser application                                      | Screens, routes, state, calls to services                                      |
| `mobile`     | An iOS or Android application                              | Screens, navigation, local storage, calls to services, store release           |
| `pipeline`   | Data processing, ETL, batch or streaming                   | Jobs, DAGs, schedulers, tables, transformations, data quality checks           |
| `ml`         | Models and the code around them                            | Datasets, features, training, evaluation, model artifacts, serving, retraining |
| `infra`      | Infrastructure as code or platform tooling                 | Cloud resources, networks, environments, pipelines that deploy them            |
| `library`    | A package, SDK or command-line tool consumed by other code | A public API or command set, versioning, release, compatibility                |
| `serverless` | Functions and event-driven components                      | Functions, triggers, queues, topics, schedules, the resources that wire them   |

A profile that is not listed here is written as the closest one and the difference is explained in `00-overview.md`. A profile is added to this table when a second project needs it.

## 4. The document set

Thirty-two numbered files. Numbers sort them in reading order and never change meaning; a project writes only the files its profiles require, and omits the rest without renumbering. "Required" in the matrix below means every project with that profile writes the file; "if present" means the project writes it when it has that part; a dash means the file does not apply. A topic that fits none of them takes a `22` slot: `22-<topic>.md`, or `22a-`, `22b-` when there are several. Sets that predate this version keep their file names; the names below are the same slots.

| File                          | What it holds                                                                                                                                                | Source of truth in the code                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `00-overview.md`              | What the project is, for whom, its profiles, its main parts, status, owners, and the list of documents in this folder                                        | README, entry points, CODEOWNERS, the onboarding sheet |
| `01-tech-stack.md`            | Languages, frameworks, runtimes, platforms and infrastructure, with versions                                                                                 | Manifests, lock files, Dockerfiles, CI, IaC            |
| `02-repository-map.md`        | Every top-level directory and key file: purpose, entry points, who imports it                                                                                | The tree                                               |
| `03-architecture.md`          | Components, how they communicate, the flow of data or requests end to end, where it runs, a diagram                                                          | Code, Dockerfiles, run scripts, configs, IaC           |
| `04-running-locally.md`       | Prerequisites, setup, run, seed data, the failures newcomers hit                                                                                             | Run scripts, README, manifests                         |
| `05-backend.md`               | Services and modules, their endpoints or handlers, workers, functions, what each owns                                                                        | Server and function code                               |
| `06-frontend.md`              | Client applications: web, mobile, or a command-line surface; structure, state, how they call services                                                        | Client code                                            |
| `07-screens-and-metrics.md`   | Each screen or command: purpose, what it shows or does, the data or calls behind it                                                                          | Client code and queries                                |
| `08-data-model.md`            | Each table, collection, schema, dataset or artifact store: the fields that matter, keys, producers, consumers                                                | DDL, ORM models, SQL, schema files                     |
| `09-data-lineage.md`          | Sources to outputs, per domain or per dataset                                                                                                                | Pipeline and training code, SQL                        |
| `10-transformations.md`       | Each processing step: input, logic, output, file and function; feature engineering and training steps for models                                             | Pipeline and training code                             |
| `11-metrics.md`               | Each metric: definition, formula, source, where computed; business metrics, model metrics or service indicators                                              | Code, dashboards as code                               |
| `12-pipelines.md`             | Each job: DAG, cron job, workflow, scheduled function or queue consumer; file, trigger, reads, writes, order, dependencies, failure behaviour, active or not | Job definitions, schedulers, scripts, IaC triggers     |
| `13-data-quality.md`          | Checks and validations that exist, where, what they catch, and the gaps                                                                                      | Code                                                   |
| `14-testing.md`               | How to run the tests, what they cover, what they do not, how CI runs them                                                                                    | Test folders, CI                                       |
| `15-integrations.md`          | Each external system: direction, protocol, authentication by name, failure modes, rate limits                                                                | Clients, configs                                       |
| `16-configuration.md`         | Every config key, environment variable and feature flag: where read, default, effect; secrets by name only                                                   | Config files, environment reads, flag definitions      |
| `17-deployment.md`            | How it is built, shipped and run per environment, and how to roll back; for a library, how it is versioned and published                                     | CI, Dockerfiles, deploy scripts, release config        |
| `18-operations.md`            | Monitoring, logs, alerts, routine tasks, limits, what to do when it breaks                                                                                   | Scripts, configs, dashboards, runbooks                 |
| `19-known-issues.md`          | Bugs, gaps, debt and security findings, each with the file that shows it                                                                                     | The code review done while writing                     |
| `20-glossary.md`              | Internal terms and acronyms, one line each                                                                                                                   | All documents                                          |
| `21-open-questions.md`        | What the code could not answer, each with who could                                                                                                          | The writing process                                    |
| `22-<topic>.md`               | Deep dives that fit nowhere else                                                                                                                             | As needed                                              |
| `23-making-changes.md`        | A cookbook: each common change with exact files, ordered steps, verification, and what else to update                                                        | Code                                                   |
| `24-dependencies.md`          | Internal module dependencies, upstream and downstream systems, data and job dependencies, the packages that matter                                           | Imports, configs, SQL, manifests                       |
| `25-change-impact-map.md`     | One row per entity: defined in, read by, written by, documented in, what to check before changing                                                            | Everything above                                       |
| `26-security-and-access.md`   | Authentication and authorisation, roles and permissions, where secrets live by name, data sensitivity, what access running and deploying needs               | Auth code, IAM and policy files, configs               |
| `27-infrastructure.md`        | Each cloud resource or environment: type, name, defined in which IaC file, depends on, who changes it                                                        | IaC, deployment manifests                              |
| `28-interfaces-and-events.md` | Contracts: API schemas, event and message schemas, queue and topic names, versioning rules, consumers                                                        | Schema files, handlers, producers, consumers           |
| `29-models.md`                | Each model: purpose, training entry point, data and features, evaluation metrics, artifact location, serving, retraining                                     | Training and serving code, registries                  |
| `30-conventions.md`           | Naming, folder rules, error handling, logging, testing and review conventions as practised in this repository                                                | The code itself                                        |
| `31-decisions.md`             | Decisions that shaped the project and the reason for each, newest first                                                                                      | Commit history, existing design notes                  |

### Which documents each profile writes

R is required, P is written if the project has that part, and a dash means not applicable. A project with several profiles takes the strongest mark across them.

| File                     | service | web | mobile | pipeline | ml  | infra | library | serverless |
| ------------------------ | ------- | --- | ------ | -------- | --- | ----- | ------- | ---------- |
| 00 overview              | R       | R   | R      | R        | R   | R     | R       | R          |
| 01 tech stack            | R       | R   | R      | R        | R   | R     | R       | R          |
| 02 repository map        | R       | R   | R      | R        | R   | R     | R       | R          |
| 03 architecture          | R       | R   | R      | R        | R   | R     | R       | R          |
| 04 running locally       | R       | R   | R      | R        | R   | R     | R       | R          |
| 05 backend               | R       | P   | –      | P        | P   | –     | –       | R          |
| 06 frontend              | P       | R   | R      | –        | –   | –     | R       | –          |
| 07 screens and metrics   | P       | R   | R      | –        | –   | –     | P       | –          |
| 08 data model            | R       | P   | P      | R        | R   | –     | –       | P          |
| 09 data lineage          | –       | –   | –      | R        | R   | –     | –       | P          |
| 10 transformations       | –       | –   | –      | R        | R   | –     | –       | P          |
| 11 metrics               | P       | P   | P      | P        | R   | –     | –       | P          |
| 12 pipelines             | P       | –   | –      | R        | R   | P     | –       | R          |
| 13 data quality          | –       | –   | –      | R        | R   | –     | –       | –          |
| 14 testing               | R       | R   | R      | R        | R   | R     | R       | R          |
| 15 integrations          | P       | P   | P      | P        | P   | P     | P       | P          |
| 16 configuration         | R       | R   | R      | R        | R   | R     | R       | R          |
| 17 deployment            | R       | R   | R      | R        | R   | R     | R       | R          |
| 18 operations            | R       | R   | R      | R        | R   | R     | P       | R          |
| 19 known issues          | R       | R   | R      | R        | R   | R     | R       | R          |
| 20 glossary              | R       | R   | R      | R        | R   | R     | R       | R          |
| 21 open questions        | R       | R   | R      | R        | R   | R     | R       | R          |
| 23 making changes        | R       | R   | R      | R        | R   | R     | R       | R          |
| 24 dependencies          | R       | R   | R      | R        | R   | R     | R       | R          |
| 25 change impact map     | R       | R   | R      | R        | R   | R     | R       | R          |
| 26 security and access   | R       | R   | R      | R        | R   | R     | R       | R          |
| 27 infrastructure        | P       | P   | –      | P        | P   | R     | –       | R          |
| 28 interfaces and events | R       | P   | P      | P        | P   | –     | R       | R          |
| 29 models                | –       | –   | –      | –        | R   | –     | –       | –          |
| 30 conventions           | R       | R   | R      | R        | R   | R     | R       | R          |
| 31 decisions             | P       | P   | P      | P        | P   | P     | P       | P          |

## 5. Front matter: the header every document starts with

Every file begins with a YAML block. It is short, it is the same in every project, and it is what turns a document into something Lumos can link to code. Lists may be empty; keys may not be missing. The example uses placeholder names; a real header names only things that exist in the repository.

```text
---
lumos: 1
project: <slug>                   # the project slug from the onboarding sheet
doc: 12-pipelines                 # the file name without .md
title: Jobs and pipelines
profiles: [service, pipeline]     # from section 3
component: pipelines              # general | backend | frontend | data | ml | infra | ops | security
owners: [team-alias@saturam.com]  # people or a team alias who can answer questions about this document
status: verified                  # verified | partial | draft
verified_commit: <12-char commit> # the commit the document was checked against
verified_on: 2026-10-15
code_paths: [src/jobs/, src/jobs/nightly_report.py]
tables: [analytics.daily_orders]
jobs: [nightly_report]            # DAG ids, cron jobs, workflow names, scheduled functions, consumers
apis: [POST /orders]
events: [orders.created]          # topics, queues, webhooks
configs: [APP_DB_URL, REPORT_HOUR]
resources: [aws_lambda_function.nightly_report]   # IaC resource names
tickets: []
---
```

| Field                                                      | Rule                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                                                  | The slug the onboarding sheet uses for this project. Lumos filters retrieval on it                                                                                                                                                                                    |
| `doc`, `title`                                             | The file name without extension, and the human title. The H1 of the document repeats the title                                                                                                                                                                        |
| `profiles`                                                 | The project's profiles from section 3, the same list in every document of the set                                                                                                                                                                                     |
| `component`                                                | One word from the list, so a question about pipelines can prefer pipeline documents                                                                                                                                                                                   |
| `owners`                                                   | Email addresses or a team alias. The mentor names these when it cannot answer. Taken from CODEOWNERS, the README or the sheet; `TBD` when none exists, and then listed in `21-open-questions.md`                                                                      |
| `status`, `verified_commit`, `verified_on`                 | `verified` means every claim was checked against that commit; `partial` means some sections are marked Unverified; `draft` means generated and not yet reviewed                                                                                                       |
| `code_paths`                                               | Every file or directory the document relies on, relative to the repository root. Each must exist at `verified_commit`                                                                                                                                                 |
| `tables`, `jobs`, `apis`, `events`, `configs`, `resources` | The entities the document describes, spelled exactly as they appear in code: `schema.table` or a dataset path; a job, DAG or function id; `METHOD /path`; a topic or queue name; a key or variable name; an IaC resource name. Empty lists when a kind does not apply |
| `tickets`                                                  | Issue keys the document relates to, when known                                                                                                                                                                                                                        |

## 6. Writing rules

1. Only facts the code shows. A sentence about how systems like this usually work is labelled as general knowledge or left out.
2. Cite code by exact relative path and the function, class or resource name. Verify the path exists before writing it. Line numbers only when they are unlikely to move.
3. When the code does not answer something, write `TBD: ask <owner>` in place and add a row to `21-open-questions.md`. Never fill a gap with a plausible guess.
4. Never a secret value. Write `hardcoded in src/settings.py` or `read from env var APP_DB_PASSWORD`, never the value. Do not open files that exist to hold secrets.
5. Lead with the answer. One idea per sentence. Define an internal term on first use and in the glossary.
6. Headings are named after the subject: "How the nightly report is triggered", not "Overview" or "Details".
7. 300 to 1,500 words per document. A longer subject is split into a `22` deep dive rather than stretched.
8. Every table, job, API route, event, config key, resource and external system named anywhere appears as a row in `25-change-impact-map.md`.
9. Every document ends with a `## Related code` section: one line per path, with why it matters. The front matter `code_paths` lists the same paths.
10. Keep the file names and numbers. Updating a set means editing in place, keeping what can be verified, marking what cannot as `Unverified on <commit>`, and never deleting a section that was not checked.
11. Write for the profiles declared. A document a profile does not require is omitted, not written empty.

## 7. Section templates

Each document has required sections, and the ones that list entities have required fields per entity. Headings may be reworded to name the subject; the information may not be dropped. Where a template says "per X", the document holds one section or one table row per X, in a fixed field order.

### 00-overview.md

- Three-sentence summary: what it is, for whom, what it produces
- Profiles declared, with one line on why each applies
- Who it serves: each user group or consuming system and what they do with it
- The domains, product areas or main parts, one paragraph each
- Status and ownership: active or not, owners, where it runs
- Document set: the list of files in this folder with one line each

### 02-repository-map.md

- One section per top-level directory: purpose, entry points, key files, who imports it, what it writes
- Files at the root worth knowing: run scripts, manifests, configuration, one line each
- What is not in the repository but needed to run it

### 03-architecture.md

- Components: each with its directory, runtime, how it is started, what it talks to
- The flow end to end: a request, a record or an event from where it enters to what it produces, naming the handlers, jobs, tables or topics on the way
- A mermaid diagram of components and arrows, in a fenced block
- Where it runs: hosts, containers, functions, ports, environments, what starts what
- Decisions worth knowing and the reason for each, when the code reveals one; longer ones go to `31-decisions.md`

### 05-backend.md

Per service or function, then per endpoint or handler within it:

- Service: directory, runtime, how it starts, what it owns, what it depends on
- Endpoint or handler: method and path, or trigger; handler file and function; authentication by name; what it reads and writes; who calls it; error behaviour
- Workers and background tasks: what starts them, what they consume, what they produce

### 06-frontend.md and 07-screens-and-metrics.md

- Application: directory, framework, how it is built and served, how it authenticates
- Per screen or command: route or name; component or entry file; the data it shows and the calls or queries behind it; who can reach it; what it writes
- State and navigation: where shared state lives, how screens connect

### 08-data-model.md

Per table, collection, dataset or artifact store:

- Name as it appears in code; where it is created or declared; the fields that matter and their meaning
- Keys and how records are identified; volume and growth when known; retention
- Produced by: the job, handler or function that writes it. Read by: the queries, screens, jobs or services that read it

### 12-pipelines.md

Per job, DAG, workflow, scheduled function or consumer, in this order:

- File: the definition. Trigger: schedule, event, queue or manual, exactly as written in code, with the timezone or a note that none is set
- Reads and Writes: tables, files, topics and external systems, by name
- Step or task order: the sequence and the parallel branches
- Must run before it: enforced dependencies, then operational ones
- Failure surfaces as: alerts, task states, logs, dead-letter queues. Retries and callbacks
- Currently active: yes or no, and how it is started in practice
- Notes: dead steps, commented-out code, known quirks

### 15-integrations.md and 28-interfaces-and-events.md

- Per external system: what it is, direction, protocol, authentication by name, the client file, rate limits, what happens when it is down
- Per API contract: where the schema lives, versioning rule, consumers known
- Per event, topic or queue: name, producer, consumers, schema location, ordering and retry rules, dead-letter handling

### 16-configuration.md

- One section per area: database, paths, endpoints, scheduling, feature flags, service-specific
- Per setting: name, where it is read, default, effect, whether it is hardcoded, environment-driven or managed by a secret store
- Feature flags: name, where evaluated, default per environment, who can change it
- Secrets: where they live, not what they are, and which are hardcoded

### 23-making-changes.md

One section per common change. The recipes are what the mentor copies when planning a change or a new feature, so each must name real files:

- The change, as an engineer would say it: add an endpoint, add a screen, add a job, add a table or field, change a schedule, rotate a credential, add an integration, add a resource
- Where: every file and setting involved, in the order to touch them
- Steps, numbered, each verifiable on its own
- Verify: how to prove it worked
- Also update: the documents, tests, contracts and downstream consumers affected
- Close with a general verification checklist that applies after any change

### 24-dependencies.md

- Internal: which modules import which, as a list or a mermaid graph; the entry points at the top
- Upstream systems the project reads from, downstream systems that read from it, each with the integration point in code
- Data and job dependencies: what must have landed or run before each job or handler
- External packages and platform services that matter, with the version pinned and why it matters

### 26-security-and-access.md

- Authentication: how callers and users are identified, where it is implemented, what is unauthenticated
- Authorisation: roles, permissions, who can do what, where it is enforced
- Secrets and credentials: where each lives by name, how it is rotated, which are hardcoded
- Data sensitivity: what personal or confidential data the project holds, where, and the rules that apply
- Access needed to run, deploy and operate it, by role

### 27-infrastructure.md

Per environment, then per resource:

- Environment: name, account or project, region, how it is reached
- Resource: type and name as in the IaC file; defined in which file; depends on; what it costs to change; who changes it and how
- Networking and access boundaries that a change could break

### 29-models.md

Per model:

- Purpose and the decision it feeds; training entry point and the data and features it uses
- Evaluation: metrics, thresholds, where they are computed
- Artifact: where it is stored and versioned; how it is served; how and when it is retrained
- Known limits and drift behaviour

### 30-conventions.md

- Naming of files, modules, tables, endpoints, events and branches, as practised, with one example each
- Folder rules: what goes where, what never goes in the repository
- Error handling, logging and configuration patterns the code actually follows
- Testing and review expectations, and what a pull request must include

## 8. The change impact map

`25-change-impact-map.md` is a single table, one row per entity, sorted by kind then name. It is the document the mentor reads first for any "what will this affect" question, and the one that most repays care. The example rows use placeholder names.

| Entity                               | Kind     | Defined in                           | Read by                         | Written by             | Documented in | Before changing                                        |
| ------------------------------------ | -------- | ------------------------------------ | ------------------------------- | ---------------------- | ------------- | ------------------------------------------------------ |
| `analytics.daily_orders`             | table    | `db/migrations/012_daily_orders.sql` | `src/api/reports.py`, dashboard | `nightly_report` job   | 08, 09, 12    | the dashboard query assumes one row per day            |
| `nightly_report`                     | job      | `src/jobs/nightly_report.py`         | operations runbook              | —                      | 12, 23        | schedule lives in `infra/schedules.tf`, not in the job |
| `POST /orders`                       | api      | `src/api/orders.py`                  | web app, mobile app             | —                      | 05, 28        | versioned contract; consumers pinned to v2             |
| `orders.created`                     | event    | `src/events/producers.py`            | `src/consumers/fulfilment.py`   | `POST /orders` handler | 28            | schema change needs both producer and consumer         |
| `APP_DB_URL`                         | config   | `src/settings.py`                    | every service                   | —                      | 16, 26        | rotating it restarts all services                      |
| `aws_lambda_function.nightly_report` | resource | `infra/jobs.tf`                      | —                               | —                      | 27            | memory and timeout set here, not in code               |

Kinds: `table`, `dataset`, `job`, `task`, `api`, `event`, `queue`, `service`, `module`, `screen`, `config`, `flag`, `secret` by name only, `resource`, `model`, `external`, `file`. "Documented in" lists document numbers. "Before changing" is one line: the check or the trap.

## 9. Quality checklist before committing

- Every path in `code_paths` and in the text exists at `verified_commit`
- Every table, job, API route, event, config key, resource and external system named in any document has a row in `25-change-impact-map.md`
- No secret value anywhere: search the folder for `password`, `secret`, `token`, `key =` and read each hit
- Every document has complete front matter, an H1 matching `title`, the same `profiles` list, and a `## Related code` section
- `owners` is filled, or `TBD` with a matching row in `21-open-questions.md`
- Every document the project's profiles require exists; none that they exclude exists
- Nothing is described that the repository does not contain; general knowledge is labelled
- `23-making-changes.md` has at least one recipe per kind of change the project actually sees
- The set was reviewed by one owner in the pull request that adds or updates it

## 10. Where the documents live, and maintenance

In the repository, under `docs/onboarding/`, on the branch the onboarding sheet names for that project. The Bitbucket indexer takes Markdown files as they are, so the documents reach the Knowledge Base on the next run after the merge with no further step. The sheet row needs nothing new: the documents are inside the repository it already lists. If a project keeps its documents in Google Drive instead, the same files and the same front matter apply, and the folder goes in the `google_drive_folders` column.

A document set is correct at `verified_commit` and drifts from there. The rule is that the pull request which changes a thing updates the document that describes it, and the reviewer checks it did. Lumos flags a document that names a symbol or path no longer present in the code, but a wrong schedule or a renamed table is only caught by this rule.

| When a pull request changes                                   | Update                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A job, schedule, trigger or consumer                          | `12-pipelines.md`, `25-change-impact-map.md`; `23-making-changes.md` if a recipe changed |
| A table, field, dataset or model artifact                     | `08-data-model.md`, `09-data-lineage.md`, `29-models.md`, `25-change-impact-map.md`      |
| An endpoint, event, screen or integration                     | `05`, `06`, `07`, `15` or `28` as applicable, `25-change-impact-map.md`                  |
| A config key, flag, secret location or permission             | `16-configuration.md`, `26-security-and-access.md`, `25-change-impact-map.md`            |
| A cloud resource or environment                               | `27-infrastructure.md`, `17-deployment.md`, `25-change-impact-map.md`                    |
| A dependency, runtime or framework version                    | `01-tech-stack.md`, `24-dependencies.md`                                                 |
| Build, deploy or operations                                   | `17-deployment.md`, `18-operations.md`                                                   |
| Anything that answers an open question or fixes a known issue | `21-open-questions.md`, `19-known-issues.md`                                             |
| A convention or a design decision                             | `30-conventions.md`, `31-decisions.md`                                                   |
| Every change                                                  | `verified_commit` and `verified_on` on the documents touched                             |

Re-verify the whole set against the current branch head every quarter, or when the sheet row's branch changes. The prompt in section 11 does this when run on an existing set: it keeps what still holds, marks what it cannot verify, and reports the difference.

## 11. The prompt

Run an AI coding assistant in the repository root, on the branch to document, and give it the text below together with this document. Claude Code is what the team uses today; the prompt names no tool. A `sat-cli docs` command that runs the same prompt with the configured provider is planned, see Appendix A.

```text
You are documenting the repository in the current working directory for Lumos, Saturam's
engineering knowledge assistant. Work on the current branch. Produce or refresh the document
set under docs/onboarding/ exactly as the Lumos Project Documentation Standard describes.
Write Markdown files and nothing else.

Ground rules
1. Every fact comes from this repository: code, configuration, scripts, tests, infrastructure
   files and existing docs. Do not describe what a project like this usually does. When
   something cannot be determined, write "TBD: ask <owner>" in place and add it to
   21-open-questions.md.
2. Cite code by exact relative path and function, class or resource name. Verify every path
   exists before writing it.
3. Never copy a secret, key, password, token or connection string. Name the file and the
   variable that hold it. Do not open files that exist to hold secrets: .env, *.pem, *.key,
   credentials.*, secrets.*.
4. Every document starts with the front matter from section 5 of the standard and ends with a
   "## Related code" section listing the paths it relies on.
5. Keep the file names and numbers from section 4. Write only the documents the project's
   profiles require. If docs/onboarding already exists, update in place: keep what you can
   verify, mark the rest "Unverified on <commit>", never delete a section you did not check.

Method
Step 1, inventory. List the tree, ignoring vendored and build directories. Read the manifests,
   entry points, run scripts, Dockerfiles, CI, infrastructure files, schedulers, job and
   function definitions, schemas, SQL and configuration. Write down every table or dataset,
   job, API route, event or queue, config key, environment variable, cloud resource, model,
   external system and internal module you find, each with its file.
Step 2, profiles. Decide the project's profiles from section 3 of the standard, based on what
   step 1 found. State them in 00-overview.md and in every front matter. They decide which
   documents to write, from the matrix in section 4.
Step 3, write the required documents in number order, applying the section templates from
   section 7. Write an "if present" document only when the repository has that part.
Step 4, fill 25-change-impact-map.md with one row per entity from step 1: defined in, read by,
   written by, documented in, what to check before changing.
Step 5, fill 23-making-changes.md with one recipe per change engineers actually make here,
   drawn from the profiles: add an endpoint, add a screen, add a job, add a table or field,
   change a schedule, rotate a credential, add an integration, add a resource, and any other
   the code suggests. Each recipe names exact files, ordered steps, verification, and what
   else to update.
Step 6, verify. Every cited path exists. Every entity in the map appears in the document that
   owns it. No secret value anywhere. Front matter complete and identical in profiles across
   the set. Owners from CODEOWNERS or the README, else TBD.
Step 7, report. Print the files written, the profiles chosen, the open questions, and anything
   in the code that looked wrong, such as hardcoded credentials, dead code or failing imports;
   put those in 19-known-issues.md as well.

Style
Lead with the answer. One idea per sentence. Define internal terms on first use and in
20-glossary.md. Headings named after the subject. 300 to 1,500 words per document. Tables for
lists of entities, mermaid for diagrams, fenced code only when the exact text is the answer.
```

When the run finishes, read `21-open-questions.md` and `19-known-issues.md` first: they are the two documents the assistant could not write from code alone, and the ones an owner must act on.

## Appendix A. How saturam-cli reads these documents

Everything above is a contract with the terminal side of Lumos, `sat-cli lumos`. This appendix lists what the CLI relies on and the order in which the CLI work lands, so the two sides stay aligned. The full plan with phases, tools and evaluation is the Mentor Agent Implementation Plan; this is the part that touches the documents.

| Document feature                                                                      | What the CLI does with it                                                                                                                                    | Lands in                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `docs/onboarding/` in the repository                                                  | Indexed as prose beside the code; `search_documentation(kind)` searches prose and code separately                                                            | Phase 1                         |
| Front matter `project`                                                                | Already the retrieval filter; unchanged                                                                                                                      | Today                           |
| Front matter `profiles` and `component`                                               | Lets the mentor prefer the right document kind for a question, and tell a user which parts a project has                                                     | Phase 1                         |
| Front matter `code_paths`, `tables`, `jobs`, `apis`, `events`, `configs`, `resources` | The pipeline writes them into the document's metadata sidecar and into a mentions index; the mentor's `find_references` returns documents beside code usages | Phase 2 pipeline, Phase 3 tools |
| `## Related code` sections                                                            | The identifier guard accepts paths a retrieved document names, so a correct path is not revised out of an answer                                             | Phase 1                         |
| `25-change-impact-map.md`                                                             | Read whole by `read_document` as the first step of a change plan; its rows seed the relationship graph                                                       | Phase 2                         |
| `23-making-changes.md`                                                                | The recipe nearest to a requested change is the template the plan follows; for a new feature, the nearest existing feature's footprint                       | Phase 2                         |
| `21-open-questions.md`, `owners`                                                      | What the mentor says when it does not know, and whom it names                                                                                                | Phase 1                         |
| `verified_commit`                                                                     | Compared with the indexed commit; the mentor says when a document is older than the code                                                                     | Phase 3                         |

### Order of work on the terminal side

1. Phase 1, CLI only: a `kind` filter on search, `read_document` from S3, `browse_repository` over the code-index state, registry v2 with repositories, and prompt guidance for code questions. Documents written to this standard are already searchable as prose; this phase lets the mentor read them whole.
2. `sat-cli docs init` and `sat-cli docs check`, CLI only: `init` runs the prompt in section 11 with the configured provider against the current repository and writes `docs/onboarding/`; `check` runs the checklist in section 9 and fails on a missing path, a missing front-matter field, a profile mismatch or a secret-shaped value. `check` runs in CI on the documents folder.
3. Phase 2: the planning method in the prompt, `begin_change_plan`, `find_symbol` and `find_references` over the symbol and reference indexes the pipeline writes, and the eval group for change plans.
4. Phase 3: the mentions index that links front matter and Related code sections to the code, the relationship graph, stale-document detection, and the architecture method in the prompt.
5. Phase 4: the second data source and hybrid search, after the first three are measured.

## Appendix B. Examples

Placeholder names throughout; a real document names only what exists in its repository.

### A Related code section

```text
## Related code

- `src/jobs/nightly_report.py` — defines the `nightly_report` job and its steps
- `infra/schedules.tf` — the schedule that actually triggers it
- `src/reports/build.py` — the functions each step calls
- `src/settings.py` — `REPORT_HOUR` and `APP_DB_URL`, which the job reads
```

### An open question

```text
| Question | Why the code cannot answer it | Who could | Status |
| --- | --- | --- | --- |
| Which timezone does the nightly schedule use? | `cron(0 2 * * ? *)` in `infra/schedules.tf` has no zone; it depends on the platform default | platform-team@saturam.com | open |
```

### A making-changes recipe

```text
## Change when the nightly report runs

Where: `infra/schedules.tf` (the trigger), not `src/jobs/nightly_report.py` (the job has no schedule of its own).

1. Edit the `schedule_expression` of `aws_cloudwatch_event_rule.nightly_report` in `infra/schedules.tf`.
2. Keep it after the upstream `orders_sync` job, or the report reads yesterday's orders.
3. Apply the infrastructure change through the usual pipeline; nothing in the application needs a deploy.

Verify: the next invocation appears in the function's logs at the new time; the `daily_orders` row for the day exists.
Also update: `12-pipelines.md` (trigger), `25-change-impact-map.md` (`nightly_report` row), `18-operations.md` if the on-call window moves.
```

### A security-and-access entry

```text
## Secrets, by name

| Secret | Lives in | Read by | Rotation |
| --- | --- | --- | --- |
| `APP_DB_PASSWORD` | the deployment's secret store, injected as an environment variable | `src/settings.py` | manual; every service restarts on change |
| `PAYMENTS_API_KEY` | hardcoded in `src/payments/client.py` (see 19-known-issues) | `src/payments/client.py` | none; must move to the secret store |
```
