# TrainerTwin ingestion deployment

This document covers the public/OAuth Notion pipeline, owned-channel YouTube
OAuth imports, and the shared Postgres database. It does not deploy the Next.js
web app or voice agent. The YouTube schema is applied to Neon and the new GCP
project has YouTube Data API enabled. The connector-neutral work-item schema and
long-video worker changes in this branch still require a later migration and AWS
deployment. Maintenance remains disabled by default.

## Flow

```text
Signed-in user → Import public Notion → Next.js POST /api/knowledge/[kb]/notion
  → Neon: KnowledgeSource + connector config + IngestionJob + IngestionWorkItem
  → SQS: {jobId, workItemId}
  → Lambda: fetch public page (no Notion credentials)
    → enqueue each discovered child as another SQS message
    → store Markdown in S3
    → existing structural chunking + topic classification + embeddings
    → Chroma Cloud records + Neon document/job status
```

OAuth imports use the same queue and worker, but load/decrypt the selected
connection's token in Lambda. Queue messages never contain tokens or page content.
TrainerTwin sign-in and organization authorization remain required for both modes.

## Resources

Account: `837735292163`. AWS region: `ap-south-1` (Mumbai).

| Resource | Name / configuration |
| --- | --- |
| Source queue (existing) | `trainertwin-notion-ingestion-prod` |
| Dead-letter queue (existing) | `trainertwin-notion-ingestion-prod-dlq` |
| Lambda | `trainertwin-notion-ingestion-prod` |
| Lambda execution role | `arn:aws:iam::837735292163:role/trainertwin-notion-ingestion-prod` |
| Role inline policy | `TrainerTwinNotionWorker` |
| Log group | `/aws/lambda/trainertwin-notion-ingestion-prod`; 14-day retention |
| App IAM user (existing) | `s3-spoken-english-with-ai` |
| App queue-send inline policy | `TrainerTwinNotionQueueSend` |
| S3 bucket (existing) | `pre-screen-sessions` |
| S3 prefix | `trainertwin/kb/<orgId>/<kbSlug>/<documentId>/` for readable content, timed transcript JSON, and staged segment artifacts |
| Postgres | Neon `neondb`; pooled endpoint supplied separately through `DATABASE_URL` |
| Vector store | Existing Chroma Cloud tenant/database from the private environment files |

Source queue URL:
`https://sqs.ap-south-1.amazonaws.com/837735292163/trainertwin-notion-ingestion-prod`

The app's new policy permits only `sqs:SendMessage` on this queue. Its pre-existing
`AmazonS3FullAccess` attachment was not changed. The Lambda role trusts only
`lambda.amazonaws.com` and permits:

- `sqs:ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes`,
  `ChangeMessageVisibility`, and `SendMessage` on the source queue only.
- `s3:PutObject` under `arn:aws:s3:::pre-screen-sessions/trainertwin/kb/*` only.
- `logs:CreateLogStream` and `PutLogEvents` in its own log group only.

Lambda uses its execution role. Do not copy the app's static AWS access keys into
Lambda. The existing S3 bucket uses SSE-S3 (`AES256`), not a customer KMS key.

## Worker settings

The deployment script uses these defaults:

| Setting | Value |
| --- | --- |
| Runtime / handler | Node.js 22 / `index.handler` |
| Memory / timeout | 2048 MB / 600 seconds |
| SQS batch size / batching window | 1 / 0 seconds |
| SQS maximum concurrent invocations | 4 |
| Partial batch failures | `ReportBatchItemFailures` |
| Source visibility timeout | 3600 seconds |
| DLQ threshold | 5 receives |
| VPC attachment | None for public Neon/Chroma endpoints |

These settings bound parallel work but do not make imports free: Lambda, SQS,
CloudWatch, S3, Neon, Chroma, and model API usage may incur charges. Neon is in
`us-east-2`; database round trips from Mumbai add latency. No RDS database or NAT
gateway is created by this setup.

## Private configuration

Keep `web/.env` and `ingestion-pipeline/.env` ignored by Git. They must use the
same `DATABASE_URL`, S3 destination, and Chroma destination. Postgres stores the
job IDs sent through SQS, so pointing only Lambda at a different database breaks
ingestion.

| Environment file | Settings |
| --- | --- |
| `web/.env` | `DATABASE_URL`, `AWS_REGION`, `INGESTION_QUEUE_URL`, app AWS credentials, existing S3/Chroma/auth settings |
| `ingestion-pipeline/.env` | `DATABASE_URL`, `AWS_REGION`, `INGESTION_QUEUE_URL`, `S3_BUCKET`, `S3_BASE_PREFIX`, `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE`, `OPENROUTER_API_KEY`, `EMBEDDING_MODEL` |

Optional worker settings: `TOPIC_MODEL`, `TOPIC_CHUNK_BATCH_SIZE`,
`INGESTION_MAX_RECEIVE_COUNT`, `NOTION_API_VERSION`, and `CHROMA_URL` for a reachable
self-hosted Chroma deployment. `NOTION_TOKEN_ENCRYPTION_KEY` is required for OAuth
sources only. Public imports never use a Notion token or browser cookie.

The supplied Neon URL uses TLS (`sslmode=require`, `channel_binding=require`).
Credentials are intentionally omitted from this document. Rotate credentials
shared through chat, and update both environment files before redeploying/restarting.

## Deploy code or environment changes

Prerequisites: Bun, AWS CLI, `zip`, valid deployment credentials, the execution role,
the log group, and a configured `ingestion-pipeline/.env`.

From the repository root:

```bash
AWS_PROFILE=default bun run --cwd ingestion-pipeline deploy
```

If the AWS CLI login has expired, run `aws login --profile default` first. The
initial setup used the user-authorized root profile; prefer a dedicated deployment
role for routine use. App and Lambda runtime identities remain separate.

The command builds `ingestion-pipeline/dist/index.js`, packages `dist/lambda.zip`,
creates/updates Lambda, waits for updates, configures the existing queue/DLQ, and
creates/updates the SQS trigger. It does not invoke the function directly. An
enabled trigger can immediately consume messages already on the source queue.

`scripts/lambda-env.ts` validates the environment and writes only allowlisted
worker variables to a temporary mode-600 file. `deploy.sh` passes the file to AWS
and removes it on exit. Secret values are not printed or included in CLI arguments.
The script rejects localhost database and self-hosted Chroma endpoints.

To use a different private environment file:

```bash
AWS_PROFILE=default PIPELINE_ENV_FILE=/absolute/path/worker.env \
  bun run --cwd ingestion-pipeline deploy
```

Resource overrides: `FUNCTION_NAME`, `LAMBDA_ROLE_ARN`, `AWS_REGION`, and
`INGESTION_QUEUE_URL`. The default role name matches the function name. Optional
deployment overrides: `LAMBDA_MEMORY_MB`, `LAMBDA_TIMEOUT_SECONDS`,
`SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_MAX_CONCURRENCY`, `SQS_MAX_RECEIVE_COUNT`,
and `DLQ_NAME`. Configure both `VPC_SUBNET_IDS` and `VPC_SECURITY_GROUP_IDS` only
when intentionally deploying into a VPC with working outbound access.

For Prisma schema changes, apply migrations to the shared database and regenerate
the web client before deploying code that needs the new schema:

```bash
cd web
bun x --no-install prisma migrate deploy
bun x --no-install prisma generate
cd ..
```

Restart the web dev server after changing `web/.env`; its cached Prisma client
retains the previous connection. For hosted web deployments, update the host's
environment variables and redeploy there too. Worker deployment does not do this.

## Verification

```bash
aws lambda get-function-configuration --profile default --region ap-south-1 \
  --function-name trainertwin-notion-ingestion-prod \
  --query '{State:State,Update:LastUpdateStatus,Runtime:Runtime,Timeout:Timeout,Memory:MemorySize}'

aws lambda list-event-source-mappings --profile default --region ap-south-1 \
  --function-name trainertwin-notion-ingestion-prod \
  --query 'EventSourceMappings[].{State:State,BatchSize:BatchSize,Result:LastProcessingResult}'

aws logs tail /aws/lambda/trainertwin-notion-ingestion-prod \
  --profile default --region ap-south-1 --since 10m
```

Do not dump the complete Lambda configuration: it includes secret environment
values. Use selective queries as above and avoid sharing content-bearing logs.

For the full user flow, open a knowledge base, click **Import public Notion**, and
enter the public page URL. Trace the job ID through the web enqueue log, Lambda
`[JOB:notion-sync]` and `[EXT-API:notion-public]` logs, Neon `IngestionJob` /
`IngestionWorkItem` / `KnowledgeDocument` rows, S3 Markdown, and Chroma records with the
same document/page IDs. Expect all discovered pages processed and nonempty
documents indexed. Container pages without text need not produce Chroma records.

The public fetcher uses an undocumented Notion web endpoint. A page being private,
a 403, response-format changes, or unsupported block types can cause failure or
incomplete extraction. The same renderer is used by the benchmark; this is not a
guarantee of complete support for every Notion block type.

## YouTube OAuth release requirements

Obtain explicit approval before creating/updating any cloud resource, changing
hosted secrets, applying database migrations, or deploying. Confirm the intended
Google project; the locally configured project is not deployment authorization.
The approved GCP project is `trainer-twin-20260828` (display name **Trainer Twin**).
See the setup record below for completed changes and remaining deployment blockers.

### Configuration and permissions

- Create a Google Auth Platform **Web application** OAuth client, configure the
  consent screen and approved origins/redirect URI, and enable YouTube Data API v3.
  Use the Google Auth Platform console workflow; `gcloud iam oauth-clients` is not
  the YouTube web OAuth client type. Expired CLI credentials need interactive login.
- Set `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, and a separate
  32-byte base64 `YOUTUBE_TOKEN_ENCRYPTION_KEY` in both web and worker environments.
  Keep these outside source control and CLI output. Back up the encryption key;
  replacing it without a re-encryption procedure makes stored credentials unreadable.
- Web also requires `YOUTUBE_OAUTH_REDIRECT_URI`, exactly matching the registered
  `/api/youtube/oauth/callback` URL. HTTPS is required except local development.
- Apply `20260828180000_youtube_oauth_ingestion` and regenerate Prisma before
  deploying web/worker code. This migration is now applied to Neon; client
  generation also completed locally.
- Extend the worker role with `s3:GetObject` on the existing `trainertwin/kb/*`
  prefix for retries, retaining `s3:PutObject` for imports. Do not add S3 delete
  permission for the disabled maintenance workflow. Keep existing queue-send access.
- Keep `YOUTUBE_MAINTENANCE_ENABLED=false` (also the default when absent). The
  deployment environment allowlist includes this flag. A maintenance event
  `{"action":"youtube-maintenance"}` returns immediately before database access
  while disabled. Normal SQS ingestion is unaffected.
- Do **not** create or enable an EventBridge schedule now. The retained design used
  EventBridge to invoke Lambda every 15 minutes; Lambda has no internal cron timer.
  A disabled handler still incurs invocation cost if called, so leaving the
  schedule uncreated avoids those periodic invocations entirely.

### Local OAuth callback

Google rejects `dash.trainertwin.localhost` as a registered redirect domain. The
development client instead registers `http://localhost:3000/api/youtube/oauth/callback`.
From `web/`, start the existing app with a fixed port:

```sh
PORTLESS_APP_PORT=3000 bun run dev
```

Portless needs this variable at launch; putting it only in the web `.env` is too
late. The existing trusted HTTPS proxy serves `dash.trainertwin.localhost`.
Only in development, an exact `Host: localhost:3000` callback with that configured
redirect URI forwards `code`, `state`, and `error` to the fixed HTTPS app callback.
The proxy port comes from Portless's trusted launch environment. The destination
still checks the signed-in user/org, single-use state, and PKCE before token exchange.
The bridge uses no-store/no-referrer headers; Next dev callback URL logs are suppressed.
It is disabled in production, which needs its own real HTTPS callback/client setup.

### Behavior and limits

User connects a channel, enters one owned video URL, checks English caption
availability, then imports or explicitly refreshes. Browser never downloads
captions or receives Google tokens. Worker rechecks ownership and fetches the
official SRT export, converts it to timestamped Markdown, and stores it at
`trainertwin/kb/<orgId>/<kbSlug>/<documentId>/content.md` before indexing.
Only existing English creator/automatic captions are eligible; no translation,
scraping, third-party transcript fallback, or speech-to-text generation is used.

SQS retains exactly `{jobId, sourceId, pageId, parentPageId}`. Encrypted credentials
are bound to the organization/user/connection. Valid access tokens are reused;
a 40-second database lease coordinates refresh across web and Lambda, and stale
refresh writers cannot overwrite newer credentials. The existing disconnect route
stops imports and marks the connection `disconnecting`. Its background finalization
is currently disabled, so Google token revocation and content cleanup do not run.
The old disconnect UI and finalization code are retained, pending a separate UX
redesign; do not present that flow as a completed Google revocation. Google may
invalidate related grants when a token is eventually revoked.
[Google OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

OAuth does not remove quota or permission failures. Caption list costs 50 units
and download costs 200; this implementation also checks channel/video ownership.
One preview plus a first worker download costs about 304 units, excluding retries
and OAuth setup. Budget quota for refreshes and connection checks as well.
[Caption list](https://developers.google.com/youtube/v3/docs/captions/list),
[caption download](https://developers.google.com/youtube/v3/docs/captions/download).

**Maintenance disabled; implementation retained:** its dormant code checks
connections daily, refreshes previously imported videos after 28 days, removes
unavailable/unrefreshed copies after 29 days, finalizes disconnect, repairs queue
publication, and removes expired OAuth state. None of these maintenance tasks
run through the Lambda handler with the flag off. Do not turn it on unchanged:
the retained code deletes S3 transcripts, database documents, and Chroma vectors,
which conflicts with the user's instruction to preserve imported knowledge.

**Production-policy blocker:** indefinite preservation after revoking YouTube
consent is not established as compliant. YouTube's revocation rules require data
deletion after revocation; its storage rules separately require refresh or deletion.
Resolve acquisition/retention and the disconnect UX before a production release.
Disabling cleanup does not waive those requirements. Privacy review must also cover
KB sharing, external model/vector providers, derived data, and downstream RAG use.
[YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies).

**Release blocker:** the existing generic knowledge deletion path deletes S3/DB
records without confirmed vector cleanup. It also leaves source records after
single-document deletion. Integrating or guarding that explicit deletion path
needs a separate scoped change before enabling this feature in production.

### Verification status

Local schema validation/client generation, web and worker typechecks, targeted web
lint, both builds, and the existing worker smoke check are the development checks.
They do not prove Google authorization, live caption availability, IAM access,
S3/vector retention, or scheduled operation. Validate those with an approved owned
video after credentials, migration, and deployments are approved. Include a private
video, another channel's video rejection, missing English captions, expired/revoked
credentials, duplicate import, retry, refresh, and the disabled maintenance event.
Do not exercise the retained destructive maintenance path against real content.

## YouTube setup record — 2026-08-28

Completed with user approval:

- Created GCP project **Trainer Twin**, ID `trainer-twin-20260828`, project number
  `1068139468290`; verified `ACTIVE`. The previous default project was not changed.
- Enabled `youtube.googleapis.com`; verified `ENABLED`. Project creation also
  enabled the standard `cloudapis.googleapis.com` service.
- Applied only the pending `20260828180000_youtube_oauth_ingestion` migration to
  the shared Neon database and regenerated the local Prisma client.
- Generated one new YouTube token-encryption key and stored it consistently in
  the ignored `web/.env` and `ingestion-pipeline/.env`, both mode 600. No existing
  secrets were replaced and no secret values were printed.
- Added IAM inline policy `TrainerTwinYouTubeTranscriptRead` to the existing
  `trainertwin-notion-ingestion-prod` role. It grants only `s3:GetObject` under
  `arn:aws:s3:::pre-screen-sessions/trainertwin/kb/*`. IAM simulation returned
  GetObject/PutObject allowed and DeleteObject implicitDeny; no delete grant was added.
- Updated the existing Lambda environment, preserving existing variables and adding
  the YouTube encryption key plus `YOUTUBE_MAINTENANCE_ENABLED=false`. Google client
  ID/secret were initially absent and added in the follow-up below.
- Deployed the verified worker ZIP to `trainertwin-notion-ingestion-prod` in
  `ap-south-1`. State `Active`, update `Successful`; local/deployed SHA-256 matched:
  `8JLaJ+mvNMXJNkjnpP8XHGUlvK5/FQijEgRy9GdsDeY=`. Previous code and configuration
  were backed up privately before the update.
- Verified one live maintenance event returned HTTP 200, no function error,
  `batchItemFailures: []`, and `[JOB:youtube-maintenance] skipped reason=disabled`.
- Replayed one already-completed Notion job: the updated worker read database
  context and returned `batchItemFailures: []` without reprocessing the content.
  This checks DB/schema compatibility, not full new-video ingestion.
- Existing SQS mapping remained enabled with batch size 1. No queue, Lambda,
  bucket, or maintenance schedule was created; no transcript/vector deletion ran.

Follow-up completed with user approval:

- User created the **Trainer Twin** consent configuration: External, Testing;
  support/developer contact fields were verified in Google Console.
- Created **Trainer Twin YouTube - Development**, a Web application OAuth client,
  with the localhost callback above. Saved the generated credentials privately
  and configured the ignored web/worker `.env` files, both mode 600.
- After AWS reauthentication, added matching client credentials to the existing
  Lambda using a revision-guarded environment update. Verified Active/Successful,
  unchanged code, preserved existing variables, and maintenance still disabled.
- Invoked the disabled maintenance event after the credential update: HTTP 200,
  no function error, empty batch failures, and the disabled-skip log. No content
  cleanup or Google token revocation ran.
- Web typecheck, targeted lint, and production build passed. Manual dummy callbacks
  verified the fixed 303 redirect, query filtering, no-store/no-referrer headers,
  and the final HTTPS callback's 401 without a session. The production build and
  non-approved Host also returned 401, without using the bridge.

Still pending: an approved Google test-user account, owner channel consent, and an
owned-video end-to-end import. Google Console currently lists zero test users and
blocks publication pending public branding information; production verification,
real-domain setup, and retention policy remain unresolved. This development setup
does not prove successful Google consent, caption download, or S3/Chroma ingestion.
Maintenance scheduling is explicitly deferred. The owner must personally approve
channel consent and supply an owned-video URL before the full ingestion test.

## Historical deployment record — 2026-08-28

The YouTube entry below records the earlier browser-prefetch experiment. It does
not verify the new OAuth implementation; legacy records are not silently reused.

- **Postgres Migration**: Copied and verified 26 tables, 14 applied Prisma migrations, and 29 initial application rows from local database to Neon (`neondb`).
- **IAM Role & Logs**: Role `arn:aws:iam::837735292163:role/trainertwin-notion-ingestion-prod` active with least-privilege SQS queue, S3 prefix (`trainertwin/kb/*`), and CloudWatch permissions. Log group `/aws/lambda/trainertwin-notion-ingestion-prod` configured with 14-day retention.
- **Lambda Function**: Deployed `trainertwin-notion-ingestion-prod` (Node.js 22 runtime, 2048 MB memory, 300s timeout, SQS trigger batch size 1 with concurrency 4).
- **Dead-Letter Queue**: Attached `trainertwin-notion-ingestion-prod-dlq` with `maxReceiveCount=5` and `VisibilityTimeout=360s`.
- **End-to-End Notion Execution**: Verified active public Notion import job `cmtcm2kw80004cu2uxlvzeoe7`:
  - Discovered and processed all 39 Notion resources (`IngestionWorkItem` status: 39/39 `succeeded`).
  - Generated and uploaded Markdown content to S3 bucket `pre-screen-sessions` under `trainertwin/kb/78c5e5fc-d525-494c-995a-21e0f97adf60/engineering/*/content.md`.
  - Executed topic classification with `openai/gpt-4o-mini` and embedding indexing with `openai/text-embedding-3-small` into Chroma Cloud.
  - 38 `KnowledgeDocument` records indexed in Neon and Chroma Cloud.
  - Ingestion job `cmtcm2kw80004cu2uxlvzeoe7` status: `succeeded`.
  - Knowledge source `cmtclopi80000cu2ujx65v3io` status: `active`.
- **End-to-End YouTube Execution**: Verified YouTube video ingestion `cmtct9fv200014v2uej5oqh9o` (`uW7MfzoD1po`):
  - Extracted 848 cue segments (37m 26s duration) via client pre-fetch.
  - Uploaded 80.6 KB timestamped Markdown to S3 (`trainertwin/kb/78c5e5fc-d525-494c-995a-21e0f97adf60/engineering/77f24f09-0805-4fa1-84b8-5c46df803268/content.md`).
  - Lambda executed `YoutubeChunker` semantic segmentation (cosine similarity threshold 0.55), OpenRouter topic classification (`gpt-4o-mini`), and batched Chroma vector indexing in batches of 250 records.
  - `KnowledgeDocument` status: `indexed` (`77f24f09-0805-4fa1-84b8-5c46df803268`).
  - Ingestion job status: `succeeded`.
  - Knowledge source status: `active`.
