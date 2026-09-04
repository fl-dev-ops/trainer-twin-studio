# Ingestion pipeline Lambda

This is the connector-neutral SQS consumer for knowledge ingestion. The Next.js
app owns OAuth, browser UI, and initial message production; this package owns
durable work-item execution for Notion and owned YouTube videos.

Each SQS message is exactly:

```json
{"jobId":"...","workItemId":"..."}
```

The handler claims an `IngestionWorkItem`, then loads its source, connector
configuration, hierarchy, and validated work instructions from Postgres. Notion
creates one resource item per discovered page. YouTube stores the complete timed
caption transcript as `transcript.json`, creates segment items spanning at most
15 video minutes, and finishes with a publication item. Each segment makes one
structured LLM request that extracts substantive spoken questions and predicts
topic candidates. Question embeddings remain staged in S3 until every segment
succeeds; only publication writes `questions.json` and replaces stable Chroma
records with one vector per question. Duplicate delivery is ignored while the
explicit 11-minute work lease is active.

## Required Lambda configuration

`DATABASE_URL`, `INGESTION_QUEUE_URL`, `S3_BUCKET`,
and either `OPENROUTER_API_KEY` or `LLM_API_KEY` are required. Optional settings:

- `NOTION_TOKEN_ENCRYPTION_KEY` is required for OAuth sources only, not public imports.
- `AWS_REGION` (default `us-east-1`)
- `S3_BASE_PREFIX` (default `trainertwin/kb`)
- `NOTION_API_VERSION` (default `2026-03-11`)
- `CHROMA_URL` (default `http://localhost:8000`), `EMBEDDING_MODEL`
- `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` for Chroma Cloud. When
  `CHROMA_API_KEY` is set, the tenant and database are required and the worker
  uses Chroma Cloud instead of `CHROMA_URL`.
- `TOPIC_MODEL`, `TOPIC_CHUNK_BATCH_SIZE`
- `INGESTION_MAX_RECEIVE_COUNT` (default `5`)

OpenRouter calls use `@openrouter/sdk` and its default endpoint; no base-URL setting
is needed. Topic normalization and catalog matching are shared with web ingestion.
YouTube sends static topic-format examples rather than the catalog to the extraction
model. Matching ignores case, spaces, dots, and hyphens. Approved matches are stored
as canonical `topics`; missing labels create `proposed` rows and remain under
`proposedTopics` until the reconciliation script runs after approval.

The database must expose `IngestionJob.activeKey` and `IngestionWorkItem` with its
work identity, hierarchy, status, payload, artifact, attempt, and lease fields.
`(jobId,workKey)` must be unique. Connector credentials and durable source state
live in `NotionSourceConfig` or `YouTubeSourceConfig`, never in SQS or work payloads.

## Build and local smoke check

```bash
bun install
bun run build
bun run smoke
```

`smoke` validates only message parsing, Notion ID normalization, and Markdown
sanitization. It does not open network connections or access Postgres.

## Public Notion imports

Signed-in TrainerTwin users can choose **Import public Notion** without connecting
a Notion workspace. The producer validates a HTTPS Notion URL, creates a
`notion_public` source with no OAuth connection, and uses the same SQS message above.
A unique connector-neutral `identityKey` deduplicates public roots within a knowledge base. Public jobs
are visible to that knowledge base's organization; OAuth jobs remain user-scoped.

The Lambda uses `src/adapters/notion/public-acquisition.ts`, shared with the benchmark fetcher, to read
one public page and render Markdown. It enqueues discovered child pages separately,
then runs the existing cleaner, structural chunker, topic classification, S3 storage,
and Chroma indexing. It never uses a Notion API token, login cookie, or OAuth fallback.
The public web endpoint is undocumented; private pages, 403s, and response changes
can cause imports to fail. It is not a complete renderer for every Notion block type.

Before trying the UI, apply `20260828120000_public_notion_sources` with the normal
Prisma migration workflow and deploy the updated Lambda. Verify that the web
web `INGESTION_QUEUE_URL` matches Lambda `INGESTION_QUEUE_URL` and both use the
same database and Chroma destination. A local Chroma URL is not reachable from AWS
Lambda unless separately networked; use the configured Chroma Cloud destination.

For a live check, import the benchmark's public root URL into a chosen knowledge
base. Follow its job ID through `[JOB:notion-sync] enqueue-*`, Lambda's
`[JOB:notion-sync]` / `[EXT-API:notion-public]` logs, `IngestionWorkItem` rows, and Chroma
records with matching document/page IDs. Confirm all pages are processed and every
nonempty document is indexed. Typechecks, a successful queue send, and a Lambda
build alone do not verify this flow.

## YouTube question artifacts

YouTube documents do not store or expose rendered transcript Markdown. The document
source key points to the complete private `transcript.json`; its nullable questions
key points to the published `questions.json` used by the web preview. Chroma stores
exactly one vector per question, embedding only the displayed question text. Approved
topics and proposed topic candidates remain separate metadata arrays.

After separately approving proposed topic rows, preview the metadata-only reconciliation
with `bun run reconcile-youtube-topics`; add `-- --apply` to update matching question
artifacts and Chroma metadata without regenerating embeddings.

## Deploy

The deployment script creates/reuses a DLQ, sets max receives to five by default,
sets Lambda timeout to 600 seconds and source visibility to 3600 seconds, and configures a batch-size-one mapping with
maximum concurrency four. It never invokes the function.

```bash
AWS_PROFILE=default bun run deploy
```

The command reads `.env` (override with `PIPELINE_ENV_FILE`), including
`DATABASE_URL`, `AWS_REGION`, and `INGESTION_QUEUE_URL`. The default function and
IAM role name is `trainertwin-notion-ingestion-prod`; override `FUNCTION_NAME` and
`LAMBDA_ROLE_ARN` if needed. Create the execution role before first deployment.
Worker secrets are passed through a temporary mode-600 environment file, removed
on exit, and are not printed or included in command arguments. Only the worker's
allowlisted variables are deployed; Lambda uses its execution role for AWS access.
See the root `DEPLOYMENT.md` for resources, permissions, and verification results.

Set both comma-separated `VPC_SUBNET_IDS` and `VPC_SECURITY_GROUP_IDS` only when the
database/Chroma endpoints require Lambda VPC placement. Override `SQS_MAX_CONCURRENCY`,
`SQS_MAX_RECEIVE_COUNT`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, or `LAMBDA_TIMEOUT_SECONDS`
only with a reason tied to measured workload.
