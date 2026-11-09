# Platform

> Shared services that store uploaded files, record provider usage, collect issue reports, and run background cleanup. This module also describes analytics, deployment configuration, environment variables, and the shared test setup. It describes the repository, not a verified snapshot of the live Vercel dashboard.

## Who uses it

- **Learners** upload files before or during calls, open files attached to their own sessions, and report problems. Invite holders can upload before joining an org (`web/lib/upload-access.ts` `uploader`, `web/app/api/documents/[id]/raw/route.ts` GET, `web/components/twin/twin-learner-flow.tsx` `ReportDialog`).
- **Org admins and team members** upload copilot attachments and can preview ready S3 uploads in their org. Both roles are studio roles (`web/app/api/uploads/route.ts` POST, `web/lib/org.ts` `getTrainerOrg`, `web/app/api/uploads/[id]/view/route.ts` GET). See [Organizations and roles](orgs-and-roles.md).
- **Voice agent, chat, copilot, and web jobs** report usage. Agent file resolution checks the org and either the call's attachment or the copilot user's ownership (`web/lib/usage.ts`, `web/lib/uploads.ts` `resolveUpload`).
- **TrainerTwin operators** configure deploys and secrets, run backfills, and receive issue emails. Cron callers run queue recovery and upload cleanup (`web/scripts/vercel-build.sh`, `web/lib/issue-alerts.ts`, `web/vercel.json`). There is no issue-triage interface in this module's submission flow (`web/app/api/issues/route.ts`).

## Words used here

| Term | Meaning |
| --- | --- |
| Org | An organization. Uploaded files and usage are attributed to its immutable ID, not its editable slug (`web/lib/s3.ts` `orgPrefix`, `web/lib/usage.ts` `resolveIdentity`). |
| Context document | `ContextDocument`: a person's uploaded file, distinct from a knowledge-base document (`web/prisma/schema.prisma`). |
| Purpose | `before`: picked before a call; `during`: attached during a call or calibration; `copilot`: attached to a studio conversation (`web/lib/uploads.ts` `UploadPurpose`). |
| Presigned URL | A temporary S3 URL for one operation. The browser uploads with PUT; readers receive GET links (`web/lib/s3.ts` `presignedPutUrl`, `presignedGetUrl`). |
| Manifest | File metadata supplied to viewers/agents: ID, name, kind, MIME type, size, and optional image dimensions, headings, summary, page count, or model-copy key (`web/lib/context-document-service.ts` `DocumentManifest`, `web/lib/uploads.ts` `finalFields`). |
| Model copy | A smaller JPEG kept next to an oversized original image for the AI to read (`web/lib/uploads.ts` `modelCopy`). |
| Delta / snapshot | One call's usage increments / a producer's running totals. Snapshots are converted into increases before storage (`web/lib/usage.ts` `recordUsage`). |
| Idempotency key | A unique usage-event key that prevents recording a retry twice (`web/prisma/schema.prisma` `UsageEvent`). |
| Outbox | Committed ingestion work not yet sent to the queue: `queued` items with no `enqueuedAt` (`web/lib/ingestion-queue.ts` `pumpIngestionOutbox`). |
| MSW | Mock Service Worker; flow tests use its Node server to answer outside-service HTTP requests (`web/tests/flows/harness.ts`). |
| E2E | End-to-end browser tests: Chrome against a real local Next.js server and test database (`web/playwright.config.ts`). |

## Data

These records live in PostgreSQL (`web/prisma/schema.prisma`):

| Record | Fields and writers |
| --- | --- |
| `ContextDocument` | Optional `orgId` and `ownerUserId`; name, MIME type, kind (`document`/`image`), size, SHA-256, extracted text, JSON manifest, creation time. New uploads store `s3Key`, not `content` bytes. `status` defaults to `ready`; `purpose` defaults to `before`; `expiresAt` is nullable. Written by `web/lib/uploads.ts`; legacy bytes moved by `web/scripts/backfill-uploads-s3.ts`. Owner deletion sets the owner ID to null. |
| `ContextDocumentChunk` | Document ID, chunk index, optional heading/page number, text. Created by upload completion/preparation; deleted with its parent. There is an index on document ID, not a unique document/chunk-index constraint (`web/lib/uploads.ts` `finalFields`). |
| `UsageEvent` | Append-only by the metering code: org, optional user/session, source, provider, model, metric, floating-point `quantity`, unique `idempotencyKey`, optional JSON metadata, creation time. No foreign keys: usage survives org/user/session deletion (`web/lib/usage.ts` `recordUsage`, schema comments). |
| `UsageCursor` | Composite primary key `(streamId, provider, model, metric)`, `lastValue`, update time. `recordUsage` prefixes the producer stream ID with the session ID and updates cursors in a transaction. |
| `IssueReport` | Kind (`bug`/`feature`/`other`), message, status default `open`, optional page URL/user agent/user/org, timestamps. User/org foreign keys use `SetNull`. POST creates the record; `triaged`, `resolved`, `closed` are documented schema values, not transitions implemented by this route (`web/app/api/issues/route.ts`). |

Upload lifecycle: `pending → ready` on successful completion; `pending → failed` on completion failure or abandonment; `ready → expired` when its expiry is past. The server-side one-request helper creates `ready` directly. The status/purpose fields are strings, not Prisma enums (`web/lib/uploads.ts` `startUpload`, `completeUpload`, `expireUploads`, `saveUploadToS3`; `web/prisma/schema.prisma`).

S3 keys are `<S3_BASE_PREFIX>/<orgId>/uploads/<id>/<safe filename>`. Names replace characters outside letters, digits, `.`, `_`, `-` with `-`, remove leading hyphens, keep at most the last 120 characters, and fall back to `file`. A model copy appends `.model.jpg` (`web/lib/uploads.ts` `uploadKey`, `safeName`, `modelCopy`). Knowledge, voices, avatars, recordings, and scenario artifacts have separate prefixes in `web/lib/s3.ts`; their records belong to their own modules.

## How it works

### Upload directly from the browser

1. `uploadFile` posts file metadata to `POST /api/uploads`. The strict JSON body requires a trimmed name (1–255 characters), MIME type (at most 120, default empty), positive integer size, purpose, and optional share code (at most 200). Invalid input returns 400 (`web/lib/upload-client.ts`, `web/app/api/uploads/route.ts`).
2. Copilot requires `getTrainerOrg`: an enabled admin/team membership in the selected org. Other purposes use `uploader`, which resolves the signed-in user and org, then accepts an org membership or an eligible role-play/twin code. Missing permission returns 403 (`web/lib/org.ts`, `web/lib/upload-access.ts`).
3. `startUpload` checks extension and declared size, generates a UUID and org-scoped key, and creates a `pending` record. Empty MIME type becomes `application/octet-stream`. Only copilot gets `expiresAt = now + 30 days`. The response is 201 with ID, content type, and a PUT URL valid for 600 seconds; its content type and declared length are signed (`web/lib/uploads.ts` `startUpload`, `web/lib/s3.ts` `presignedPutUrl`).
4. The browser PUTs bytes to S3 with that content type, then posts `/api/uploads/<id>/complete`. A failed PUT stops this flow; the pending record remains for cleanup (`web/lib/upload-client.ts` `uploadFile`). The bucket must allow browser PUT through CORS, as noted in `web/lib/s3.ts`.
5. Completion requires a signed-in session (401 otherwise), finds the document by owner (404 otherwise), and passes its stored org to `completeUpload`. That helper accepts only an owner/org-matching `pending` upload with an S3 key (`web/app/api/uploads/[id]/complete/route.ts`, `web/lib/uploads.ts`).
6. Completion reads the actual bytes. Preparation checks size, extension/MIME compatibility, PDF header or recognizable image structure, calculates SHA-256, and extracts document text/chunks. The purpose-specific size/type check runs again against prepared metadata. Successful completion saves `ready` and schedules resume-claim extraction (`web/lib/context-document-service.ts` `prepareContextDocument`, `web/lib/uploads.ts` `completeUpload`). Resume/session use belongs to [Sessions](sessions.md).
7. Images above 2.5 × 1024² bytes **or** 4096 pixels on either side get a rotated, fit-within-2048×2048 JPEG, quality 85, without enlargement. The original remains. Small images get no copy (`web/lib/uploads.ts` `modelCopy`).
8. On preparation/completion failure, the helper attempts to delete the original object and mark the row `failed`; cleanup errors are swallowed. `UploadError` keeps its status; other messages matching `Unsupported`, `does not match`, or `exceeds` become 400, others 422 (`web/lib/uploads.ts` `completeUpload`).

The older multipart `POST /api/upload` remains: it accepts `file` and optional `shareCode`, uses `uploader`, and calls `saveUpload → saveUploadToS3`. It does **not** use the pending/presigned lifecycle or the stricter purpose policy. `GET /api/upload` lists only the current user's ready, non-copilot files in the selected org, newest first (`web/app/api/upload/route.ts`, `web/lib/specs.ts` `saveUpload`, `listUploads`).

### Read an upload

- `GET /api/uploads/<id>/view` requires sign-in, `ready`, an S3 key, and a non-null org. The owner is allowed; anyone else must be an enabled admin/team member of that document's org. Unauthorized non-owners receive 404. It redirects (302) to a 300-second GET URL for the **original**, not the model copy (`web/app/api/uploads/[id]/view/route.ts`).
- `resolveUpload` always queries by org and document ID. Pending/failed/missing gives 404; expired status or a past expiry gives 410. With a session ID, the document must be that org session's `contextId` or in its document links (403 otherwise). With an owner ID, the query also filters by owner. Ready S3 files resolve to 300-second links, using a model copy when present; legacy PostgreSQL bytes become base64 (`web/lib/uploads.ts` `resolveUpload`, `web/lib/upload-bytes.ts` `uploadBytes`).
- The chat bridge's `resolveUpload` action requires a session ID and calls that session-bound resolver. Copilot's action passes the acting trainer's owner ID and `pdfAsText: true`: PDF attachments become base64 Markdown named `<name>.md`, not native PDF bytes. Images remain images; scanned PDFs without extracted text get an explanatory text placeholder (`web/app/api/copilot/studio/route.ts`, `web/lib/copilot-studio.ts` `runCopilotStudio`). See [Copilot](copilot.md) and [Voice agent and chat](voice-agent-and-chat.md) for transport details.
- `GET /api/documents/<id>/raw?sessionId=…` requires the current user/org's session-document link and returns bytes with the MIME type, inline filename, `nosniff`, and private/no-store caching. `uploadBytes` prefers S3 and falls back to legacy `content`; it throws when neither exists (`web/app/api/documents/[id]/raw/route.ts`, `web/lib/upload-bytes.ts`).

### Record usage

The ledger stores physical usage, not prices or credit balances. Accepted metrics are `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `embedding_tokens`, `stt_seconds`, `tts_characters`, `tts_seconds`, `connected_seconds`, and reference-only provider `cost_usd`. Sources are `voice_agent`, `chat`, `copilot`, `runtime`, `report`, `synthesis`, `spec`, `rerank`, `evaluate`, `resume_claims`, `persona_analysis`, `ingestion`. These are schema allowlists, not a promise that every source emits every metric (`web/lib/usage.ts` `USAGE_METRICS`, `USAGE_SOURCES`). Credit deduction is separate; see [Credits](credits.md).

1. Internal HTTP producers POST a strict delta or snapshot body with a Bearer `COPILOT_SERVICE_SECRET`. Missing/wrong secret returns 401. Invalid JSON/schema returns 400 and up to five validation issues (`web/app/api/internal/usage/route.ts`).
2. Session usage is attributed from `InterviewSession`, ignoring producer-supplied org/user. An unknown session returns 404. A delta without a session may supply org and optional user; no usable identity returns 400 (`web/lib/usage.ts` `resolveIdentity`; route POST).
3. Deltas write only positive items. Their unique key is `<producer key>:<provider>:<model>:<metric>`; duplicate rows are skipped. Snapshots read each session-scoped cursor, insert only `total − lastValue > 0`, update the cursor, and use `<session>:<stream>:<provider>:<model>:<metric>:<seq>` for the event key, all in one transaction (`web/lib/usage.ts` `recordUsage`).
4. Web callers use `meterUsage`, which never throws and logs failures; no meter or no items is a no-op. A missing key gets a source-prefixed random UUID. `meterUsageLater` uses Next's `after`, falling back to starting metering immediately outside a request (`web/lib/usage.ts`). Provider shape adapters retain reasoning/cache as separate metrics: OpenAI completion tokens already include reasoning; Gemini output adds candidates and thoughts (`chatCompletionItems`, `geminiItems`, `aiSdkItems`).
5. Voice snapshots collect STT seconds, TTS characters/audio seconds, learner-connected room seconds, and separate screen-vision token usage. They deliberately omit the brain's LLM usage because chat reports that. A lock serializes posts; the loop runs every 10 seconds, with a final flush at close. Failed sends leave totals for a later flush (`agent/src/usage.py` `UsageReporter`).
6. Chat and copilot instrumentation records completed model calls only, using `eve:<event idempotency key>`. Chat needs a TrainerTwin session ID; copilot needs an org ID from runtime context and can include the trainer. Delivery starts without blocking the model; `flushUsage` drains outstanding posts. Each post has a 3-second timeout and at most two attempts; 429/5xx and network failures may retry, other 4xx stop (`chat/agent/instrumentation/usage.ts`, `copilot/agent/instrumentation/usage.ts`, `chat/agent/lib/usage.ts`, `copilot/agent/lib/usage.ts`).

### Report an issue and alert operators

1. Studio's dialog sends kind, trimmed message, current URL, and a timestamped PostHog replay URL if available. The learner twin dialog also sends a session ID and combines selected reasons/free text into the message (`web/components/report-issue-dialog.tsx`, `web/components/twin/twin-learner-flow.tsx` `ReportDialog`).
2. POST requires sign-in (401). Strict validation accepts `bug` (default), `feature`, or `other`; message length 5–5000 after trimming; optional nullable page URL (max 2048, not URL-validated); optional HTTPS replay URL (max 2048); optional session ID (max 100). Invalid input returns 422 (`web/app/api/issues/route.ts`).
3. The route attributes the org from the portal host first, otherwise the session's selected membership. It saves the issue, user agent truncated to 500 characters, user and org; then returns 201 with ID. Replay URL and session ID are passed to background alerts, **not stored in `IssueReport` columns** (`web/app/api/issues/route.ts`, `web/prisma/schema.prisma`).
4. `after()` looks up org details and calls `alertIssueReport`. With PostHog configured, it captures an exception using the reporter's user ID, a fingerprint `issue-report-<reportId>`, a new event UUID, full issue properties, replay URL and session ID. The exception's title uses the first non-empty message line, up to 200 characters. It flushes PostHog before email (`web/lib/issue-alerts.ts`).
5. Email goes to `devops@foreverlearning.in`, CC `harini@foreverlearning.in` and `cathy@foreverlearning.in`. It includes reporter, org, message, page, replay, PostHog event link, and a studio session link only if that session is found in the attributed org. The session link selects `/twin/sessions/…` or `/roleplay/sessions/…`. Without PostHog, email still runs without its event link. Failures are logged; the saved report is not rolled back and there is no retry queue here (`web/lib/issue-alerts.ts`, `web/lib/email.ts` `sendIssueReportEmail`, `web/app/api/issues/route.ts`).

### Scheduled work

This is the complete cron list in the two requested manifests. Schedules use Vercel cron's UTC clock (`web/vercel.json`, root `vercel.json`; the expiry time is also recorded in `plans/uploads-to-s3.md`, “As built”).

| Manifest | Path and schedule | Work |
| --- | --- | --- |
| `web/vercel.json` | `/api/internal/ingestion/pump` — `*/2 * * * *` (every two minutes) | Recover unsent ingestion outbox items, then drain the persona analysis queue (`web/app/api/internal/ingestion/pump/route.ts`). |
| `web/vercel.json` | `/api/internal/uploads/expire` — `30 3 * * *` (03:30 daily) | Fail abandoned pending uploads and expire due ready uploads (`web/app/api/internal/uploads/expire/route.ts`). |
| Root `vercel.json` | `/api/internal/ingestion/pump` — `*/2 * * * *` | Same endpoint; the root manifest has no upload-expiry cron. |

Both endpoints accept GET and POST, are force-dynamic, and set a 300-second maximum duration. They accept Bearer or `x-internal-secret`, using `CRON_SECRET` before `INTERNAL_API_SECRET`. With neither secret, they admit requests only when `VERCEL` is absent. Authorization failure returns 401; caught job failure returns 500 (`web/app/api/internal/ingestion/pump/route.ts`, `web/app/api/internal/uploads/expire/route.ts`).

- Pump defaults to 50 outbox items, caps the query `limit` at 200, and has no lower-bound/integer/NaN validation. It picks oldest queued items with `enqueuedAt = null`, publishes to SQS, and only then sets `enqueuedAt`. Per-item failures log and continue; no queue URL means no sends. Persona drain failures are caught separately, so the route can return `ok: true` with a persona error (`web/lib/ingestion-queue.ts` `pumpIngestionOutbox`, route POST). Persona processing recovers stale active sources and analyzes queued sources; see [Knowledge](knowledge.md) and [Personas and voice](personas-and-voice.md) for those lifecycles (`web/lib/persona-analysis-queue.ts` `drainPersonaAnalysisQueue`).
- `expireUploads(now, limit = 200)` selects **up to 200 in each group**: pending older than one day → attempt original-object deletion, mark failed; ready with `expiresAt < now` → attempt original/model-copy deletion, set expired, clear legacy content. It does not filter the due group by purpose. It keeps the row, text, chunks, manifest and keys. S3 deletion failures are ignored, and counts report selected rows, not confirmed deletions (`web/lib/uploads.ts` `expireUploads`).

### Analytics and errors

- Browser PostHog initializes only when `NEXT_PUBLIC_POSTHOG_KEY` exists, using `NEXT_PUBLIC_POSTHOG_HOST` or `https://us.i.posthog.com`. It disables automatic pageviews and sets person profiles to `identified_only`; the code relies on PostHog Cloud settings for session recording (`web/instrumentation-client.ts`).
- The root layout mounts `PostHogTracker`. Pathname/search-parameter changes capture `$pageview` with the full browser URL. Session changes identify the user by ID; loss of an identified user resets PostHog (`web/app/layout.tsx`, `web/components/posthog/tracker.tsx`).
- Client error boundaries capture exceptions when enabled. The ordinary boundary excludes the app's not-found errors; the global boundary does not have that exclusion (`web/app/error.tsx`, `web/app/global-error.tsx`).
- Node request errors use `getPostHogServer`, extract `distinct_id` from a PostHog cookie when possible, otherwise use `server`, capture, then shut down the client. The server client is a singleton with `flushAt: 1`, `flushInterval: 0`; no key means no client (`web/instrumentation.ts` `onRequestError`, `web/lib/posthog-server.ts`). Node startup also installs an Undici fetch dispatcher with 60-second keep-alive (`web/instrumentation.ts` `register`).

### Environments and deploys

| Deployable | Repository evidence and build |
| --- | --- |
| Studio: `trainer-twin-studio` | Local Vercel link `web/.vercel/project.json`; source root `web/`. `web/vercel.json` enables Fluid and sets `sh scripts/vercel-build.sh`. `web/package.json` build runs `prisma generate && next build`. Studio, auth and learner subdomains share this web app; see [Authentication](auth.md). |
| Chat: `trainer-twin-chat` | Local Vercel link `chat/.vercel/project.json`; `chat/vercel.json` enables Fluid. `chat/package.json` uses `eve build` / `eve start`. This is the call brain, not the studio copilot. |
| Copilot: `trainer-twin-copilot` | Project/domain recorded in `plans/copilot-v2.md`: `copilot.trainertwin.com`. `copilot/package.json` uses `eve build`, `eve deploy`, `eve start`. Sandbox choice is `VERCEL` → Vercel Sandbox; otherwise just-bash (`copilot/agent/sandbox.ts`). No local Vercel project-link file is present here. |
| Docs: `trainer-twin-docs` | `docs/vercel.json` redirects the `trainer-twin-docs.vercel.app` host permanently to `docs.trainertwin.com`, preserving the path, and serves `dist`. `docs/package.json` build exports Mintlify, unzips it to `dist`, and copies the Postman collection. No local project-link file is present here. |

The root manifest sets region `bom1`; `web/vercel.json` does **not** set a region. Which manifest is effective depends on the Vercel project's root/configuration; do not assume both cron lists merge (`vercel.json`, `web/vercel.json`).

Production build order (`web/scripts/vercel-build.sh`):

1. Only when `VERCEL_ENV = production`, require `DATABASE_URL_UNPOOLED` and run `bunx prisma migrate deploy` with that direct URL temporarily assigned to `DATABASE_URL`. Missing URL or failed migration stops the deploy (`set -e`). Prisma reads that URL through `web/prisma.config.ts`.
2. Run `backfill-scenario-item-versions.ts`: tag previously unversioned Chroma scenario items with their agent's current version; skip already-tagged items. Then `backfill-skill-sources.ts`: read live artifacts' `items.json` from S3 and insert `SkillSource` rows for versions with none. These use the normal process environment after the migration command. Each failure is non-fatal and prints a fallback warning (`web/scripts/vercel-build.sh`, both backfill scripts).
3. Always `bun run build`. Preview/development builds skip migrations and both backfills. The shell comment says previews have no database, but the script does not remove a supplied URL; `web/env.ts` still requires `DATABASE_URL` unless validation is skipped. See Open questions.

Upload migration is a **separate manual script**, not one of those deploy backfills: `bun scripts/backfill-uploads-s3.ts [--apply]` from `web/`. Default is dry run. It selects rows with legacy content and no S3 key, writes bytes, reads them back, compares byte length, then sets the key and clears `content`. Repeat runs skip moved rows; a failed check stops before clearing that row's content (`web/scripts/backfill-uploads-s3.ts`).

Local processes and ports are defined in `ecosystem.config.cjs`: studio 3000, chat 2000, copilot 2001, voice agent via `uv`. `setup.sh` configures local Portless/TLS hosts, not migrations or seeds. The production release log records a historical `v2` production branch and web → chat → copilot promotion, not a checked current dashboard setting (`plans/prod-release-v2.md`, release log; `plans/prod-migration.md`).

### Environment variables

“Required” below means needed for that feature to work, not necessarily enforced at build. `web/next.config.ts` imports `web/env.ts`; its required server field is `DATABASE_URL`, and `SKIP_ENV_VALIDATION` bypasses validation. Most other services read `process.env` directly. Examples are inventories, not proof a credential exists in a deployment (`web/.env.example`, `copilot/.env.example`).

| Use | Variables and actual behavior |
| --- | --- |
| Web DB/build | `DATABASE_URL` is URL-validated. Production migration additionally requires `DATABASE_URL_UNPOOLED`; `VERCEL_ENV` selects the production branch of the shell script (`web/env.ts`, `web/scripts/vercel-build.sh`). `web/lib/db.ts` itself has a local PostgreSQL fallback; that is not production provisioning. |
| Host/auth | Set `NEXT_PUBLIC_BASE_DOMAIN` for the deployed domain (default `trainertwin.localhost`); configure `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` as shown in `web/.env.example`. Google sign-in is enabled only with both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (`web/lib/base-domain.ts`, `web/lib/auth.ts`). Auth owns cookie/OAuth details; see [Authentication](auth.md). |
| Upload S3 | `S3_BUCKET` or fallback `AWS_S3_BUCKET`; `AWS_REGION` defaults to `ap-south-1`; `S3_BASE_PREFIX` defaults to `trainertwin-dev`. Explicit credentials use `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; without an access key the SDK uses its default credential chain. `s3Configured` checks only bucket + access-key presence, not secret validity or connectivity (`web/lib/s3.ts`). |
| Cron/queue | Set `CRON_SECRET` (fallback `INTERNAL_API_SECRET`); on Vercel, absence denies both scheduled routes. SQS dispatch needs `INGESTION_QUEUE_URL`; region order is `AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`, distinct from the S3 default. The SQS client uses the AWS SDK credential chain (`web/app/api/internal/ingestion/pump/route.ts`, `web/app/api/internal/uploads/expire/route.ts`, `web/lib/ingestion-queue.ts`). |
| Shared services | `COPILOT_SERVICE_SECRET` authenticates usage ingest, chat studio actions, and the web-to-copilot proxy. Web needs `EVE_ORIGIN` for copilot; absence of either makes the proxy return 503. Chat/copilot metering needs `STUDIO_URL` (default `http://localhost:3000`) and the same service secret (`web/app/api/eve/v1/[[...path]]/route.ts`, `web/app/api/internal/usage/route.ts`, `chat/agent/lib/usage.ts`, `copilot/agent/lib/usage.ts`). `CHAT_URL` is separately configured for the call runtime (`web/.env.example`, `web/lib/interview-sessions.ts` `initializeChatSession`). |
| Copilot publication/storage | `SCENARIO_INGEST_SECRET` must match between copilot and web's internal studio/publication endpoints; it is **not** the usage-ingest secret (`web/app/api/internal/copilot-studio/route.ts`, `copilot/.env.example`). Copilot uses `CEREBRAS_API_KEY` for its model. `INGEST_S3_BUCKET`, optional `INGEST_S3_PREFIX` and AWS credentials select S3 source/output storage; without a bucket it uses local `INGEST_USERS`/`INGEST_OUTPUT` paths, with developer-machine defaults (`copilot/agent/lib/model.ts`, `origin.ts`). See [Copilot](copilot.md). |
| Web model access | Key precedence is `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `OPENROUTER_API_KEY`, then `LLM_API_KEY` in `resolveAiGatewayConfig`. Base URL order is `AI_GATEWAY_BASE_URL`, `OPENROUTER_BASE_URL`, then `https://ai-gateway.vercel.sh/v1`. The typed env supplies a `key-required` placeholder, so passing validation does not prove working model access (`web/env.ts`). |
| Chat models/tracing | Speaking/decision models are fixed in `chat/agent/lib/models.ts`; `AI_GATEWAY_API_KEY` and `CEREBRAS_API_KEY` are documented service credentials (`chat/README.md`). Optional `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` export traces; deployment metadata uses `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA` (`chat/agent/instrumentation/langfuse.ts`). See [Voice agent and chat](voice-agent-and-chat.md). |
| Analysis/search backfills | `GEMINI_API_KEY` supports persona source analysis (`web/lib/persona-synthesis.ts`). Chroma uses `CHROMA_URL` for self-hosting, otherwise `CHROMA_API_KEY` for Cloud; tenant defaults to `default_tenant` (`web/lib/chroma-tenant.ts`). These also affect the production scenario-item backfill. See [Knowledge](knowledge.md) and [Personas and voice](personas-and-voice.md). |
| Issue email | `RESEND_API_KEY` enables sending; without it `sendEmail` returns failure and logs. `RESEND_FROM_EMAIL` defaults to `TrainerTwin <no-reply@trainertwin.com>`; reply-to is `support@trainertwin.com` (`web/lib/email.ts`). |
| Analytics | Optional `NEXT_PUBLIC_POSTHOG_KEY`; `NEXT_PUBLIC_POSTHOG_HOST` defaults to the US ingestion host. No key disables explicit client/server captures (`web/instrumentation-client.ts`, `web/lib/posthog-server.ts`). |
| Session dependencies | LiveKit requires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; URL must start `ws://` or `wss://`. Agent name defaults to `intervoo-agent` (`web/lib/livekit.ts` `getLiveKitConfig`). Browser URL, TTS/provider keys, payment keys and connector secrets are feature-owned; inventories start at `web/.env.example`, `agent/.env.example`. See [Sessions](sessions.md), [Payments](payments.md), [Knowledge](knowledge.md), and [Voice agent and chat](voice-agent-and-chat.md), rather than treating every example variable as globally required. |

## Rules

1. A browser upload accepts only PDF, PNG, JPG/JPEG, or WebP extensions, case-insensitively. `before` allows each up to 10 × 1024² bytes. `during` and `copilot` allow images up to 5 × 1024² and PDFs up to 10 × 1024². Exact boundaries pass; larger files fail. No browser-purpose DOCX, TXT, or other types (`web/lib/context-upload.ts` `uploadProblem`, `uploadAllowed`; `web/lib/uploads.ts` `whenOf`).
2. Copilot upload start requires an enabled studio membership. Other starts require the resolved org/user plus membership or an allowed code. A role-play code must be pending, unexpired, for an active deployment, match the user, and have no completed/abandoned assignment session. A twin code uses `twinAccessByCode` with `join: false` and a twin that enables pre- or during-upload (`web/app/api/uploads/route.ts`, `web/lib/upload-access.ts`).
3. Completion is owner-only and pending-only. Repeating completion after success is not an idempotent success: no pending row means 404 (`web/app/api/uploads/[id]/complete/route.ts`, `web/lib/uploads.ts` `completeUpload`).
4. The presigned PUT binds type and declared length for ten minutes. Server completion still checks actual bytes and purpose limits; metadata alone cannot mark a file ready (`web/lib/s3.ts` `presignedPutUrl`, `web/lib/uploads.ts` `completeUpload`).
5. Agent resolution must be org-scoped and enforce the supplied owner/session constraint. The chat entry point requires a session; copilot requires the trainer as owner. Expired uploads resolve as 410 even before cleanup runs (`web/lib/uploads.ts` `resolveUpload`, `web/app/api/copilot/studio/route.ts`, `web/lib/copilot-studio.ts`).
6. Only copilot's presigned-start flow assigns a 30-day expiry. Before/during uploads have no automatic expiry there. Cleanup uses strict `<` comparisons for both due expiry and pending older than one day (`web/lib/uploads.ts` `startUpload`, `expireUploads`).
7. Usage HTTP payloads are strict objects. Provider/model/identity/key labels are trimmed, 1–200 characters; values are finite and nonnegative; item lists contain 1–50 entries; metadata JSON is at most 4000 characters. Snapshots require a session, stream ID, and nonnegative integer sequence (`web/lib/usage.ts` `usageInputSchema`). The in-process `recordUsage` helper does not itself call this validator.
8. Session identity wins over supplied org/user. Org-only deltas are trusted internal input; they do not perform a membership lookup (`web/lib/usage.ts` `resolveIdentity`).
9. Retried deltas with identical expanded keys add no rows, and zero values add no rows. The unique key is global, not automatically org/session/source-scoped; producers must choose distinct base keys for distinct events (`web/lib/usage.ts` `recordUsage`, `web/prisma/schema.prisma` `UsageEvent`).
10. Snapshot cursors are session/stream/provider/model/metric-scoped. Equal/lower totals add nothing; a new stream starts its own totals. Sequence is used for the event key, not as a last-sequence guard (`web/lib/usage.ts` `recordUsage`).
11. Issue submission requires sign-in, not studio membership. Invalid bodies return 422; every successful submission creates a new report, with no idempotency key or rate limit in this handler (`web/app/api/issues/route.ts`).
12. Saving an issue must precede background alerts. Alert failure cannot undo the saved report; session links are restricted to the report's attributed org (`web/app/api/issues/route.ts`, `web/lib/issue-alerts.ts`).
13. Cron authentication fails closed on Vercel if neither cron/internal secret is set, but permits off-Vercel requests without a secret (`web/app/api/internal/ingestion/pump/route.ts`, `web/app/api/internal/uploads/expire/route.ts`).
14. Production migration failure stops the web build; either data-backfill failure does not. Non-production builds run neither migration nor deploy backfill (`web/scripts/vercel-build.sh`).
15. Test database derivation accepts only `localhost` or `127.0.0.1`; it appends `_test` unless already present and never intentionally targets the original dev database (`web/tests/setup/test-db-url.ts`, `web/scripts/test-db-setup.ts`).

## Entry points

| Entry | Code |
| --- | --- |
| POST `/api/uploads` | `web/app/api/uploads/route.ts`: start metadata/presigned flow. |
| POST `/api/uploads/[id]/complete` | `web/app/api/uploads/[id]/complete/route.ts`: owner completion, Node runtime, 60-second maximum. |
| GET `/api/uploads/[id]/view` | `web/app/api/uploads/[id]/view/route.ts`: authenticated preview redirect. |
| GET, POST `/api/upload` | `web/app/api/upload/route.ts`: own-file list / legacy multipart upload. |
| GET `/api/documents/[id]/raw?sessionId=…` | `web/app/api/documents/[id]/raw/route.ts`: session-authorized original bytes. |
| POST `/api/copilot/studio`, action `resolveUpload` | `web/app/api/copilot/studio/route.ts`: service-secret/org/session-bound chat file resolver. |
| POST `/api/internal/copilot-studio`, action `resolveUpload` | `web/app/api/internal/copilot-studio/route.ts`, `web/lib/copilot-studio.ts`: ingest-secret and enabled studio-member checks, owner-bound copilot file resolver. |
| POST `/api/internal/usage` | `web/app/api/internal/usage/route.ts`: provider usage ingest. |
| POST `/api/issues` | `web/app/api/issues/route.ts`: create issue and schedule alerts. UI: `web/components/report-issue-dialog.tsx`, learner `web/components/twin/twin-learner-flow.tsx`. |
| GET, POST `/api/internal/ingestion/pump` | `web/app/api/internal/ingestion/pump/route.ts`: cron/manual recovery. |
| GET, POST `/api/internal/uploads/expire` | `web/app/api/internal/uploads/expire/route.ts`: cron/manual cleanup. |
| Build and backfill scripts | `web/scripts/vercel-build.sh`, `backfill-scenario-item-versions.ts`, `backfill-skill-sources.ts`, `backfill-uploads-s3.ts`. |
| Analytics hooks | `web/instrumentation-client.ts`, `web/instrumentation.ts`, `web/components/posthog/tracker.tsx`, `web/app/error.tsx`, `web/app/global-error.tsx`. |
| Operator issue email | `web/lib/email.ts` `sendIssueReportEmail`, called by `web/lib/issue-alerts.ts`; no reporter confirmation email in that flow. |
| Test setup/commands | `web/scripts/test-db-setup.ts`, `web/bunfig.toml`, `web/package.json`, `web/playwright.config.ts`, `web/e2e/server.ts`. |

## Talks to

- **S3:** direct browser PUTs, server reads/writes/deletes, and temporary GET links. Legacy reads fall back to PostgreSQL. S3 CORS is a deployment requirement, not configured by this module (`web/lib/s3.ts`, `web/lib/upload-client.ts`, `web/lib/upload-bytes.ts`).
- **Sessions, chat, copilot:** pass document IDs and `trainertwin-upload://<id>` references instead of original file bytes in messages; authorized resolvers return a signed URL or inline data (`web/lib/upload-client.ts`, `web/lib/uploads.ts`). Attachment/session policy belongs to [Sessions](sessions.md), [Copilot](copilot.md), and [Voice agent and chat](voice-agent-and-chat.md).
- **Knowledge/personas:** the pump hands unsent work to SQS and triggers persona analysis; production backfills read Chroma and S3. The pump is a recovery caller, not the owner of indexing/analysis rules (`web/lib/ingestion-queue.ts`, `web/lib/persona-analysis-queue.ts`, production backfill scripts). See [Knowledge](knowledge.md), [Personas and voice](personas-and-voice.md).
- **PostHog/Resend:** analytics, request/client exceptions, issue-specific exceptions, and operator email. Issue alerts include report text, reporter email, org slug, page and replay links; this is data leaving the application (`web/lib/issue-alerts.ts`, `web/lib/email.ts`, `web/components/posthog/tracker.tsx`). See [Invites and emails](invites-and-emails.md) for other email types.
- **Vercel/Neon/Mintlify:** Vercel manifests and builds, PostgreSQL migrations via a direct connection, Eve deployables, and exported documentation (`web/scripts/vercel-build.sh`, `plans/prod-migration.md`, `chat/package.json`, `copilot/package.json`, `docs/package.json`).

## Edge cases and limits

- **Legacy upload policy differs.** `saveUploadToS3` runs the general preparer (20 × 1024²-byte cap and a broader extension set), not `uploadAllowed`, and does not set `expiresAt` even if a caller explicitly passes purpose `copilot`. Office extensions are listed by the preparer, but its non-PDF document branch rejects binary zero bytes and many Office MIME types. Do not promise all listed Office types work (`web/lib/uploads.ts` `saveUploadToS3`, `web/lib/context-document-service.ts`).
- **No full image-decoder validation at the policy check.** `inspectImage` recognizes PNG/JPEG/WebP headers/dimensions but does not require detected format to equal the extension; the returned MIME is based on extension. Small images may avoid Sharp entirely (`web/lib/context-document-service.ts` `inspectImage`, `prepareContextDocument`, `web/lib/uploads.ts` `modelCopy`).
- **Cleanup is not guaranteed erasure.** Failed S3 deletions still allow rows to become failed/expired and fall out of later cleanup selections. Text/chunks remain. The view route checks status but not `expiresAt`, so a due-but-not-yet-expired row can still redirect; the agent resolver checks both (`web/lib/uploads.ts` `expireUploads`, `resolveUpload`, `web/app/api/uploads/[id]/view/route.ts`).
- **Multi-step writes can leave leftovers.** Start creates a pending row before signing; server-side saving uploads to S3 before DB creation. These operations have no cross-service rollback. Completion failure only attempts deletion of the original, not a model copy already written (`web/lib/uploads.ts` `startUpload`, `saveUploadToS3`, `completeUpload`).
- **Snapshot concurrency is intentionally limited.** The code's `shortcut:` assumes serial posts per stream, enforced by the Python reporter lock. It uses read-then-write cursors, not row locking. Concurrent posts or a reused sequence with larger totals can cause conflicts; a counter reset within the same stream records no more until it passes the old total (`web/lib/usage.ts` `recordUsage`, `agent/src/usage.py`).
- **Metering is best-effort delivery.** In-memory pending posts, bounded retries and nonthrowing web meters do not form a durable delivery queue. Failed/partial model calls are not recorded by the completed-only Eve instrumentation (`chat/agent/lib/usage.ts`, `copilot/agent/lib/usage.ts`, both instrumentation files, `web/lib/usage.ts`).
- **Reporting success means saved, not delivered.** PostHog flush failures are caught, but an earlier exception in alert construction/capture can abort that alert invocation before email; the route catches/logs it. No background alert retry is stored (`web/lib/issue-alerts.ts`, `web/app/api/issues/route.ts`).
- **Test network safety has limits.** Flow MSW records unhandled calls but uses `onUnhandledRequest: "bypass"`; tests must assert `unexpected` is empty. `.env.test` blanks some keys and points LiveKit/chat at fake hosts, not every external provider. E2E env overrides also inherit unspecified variables (`web/tests/flows/harness.ts`, `web/.env.test`, `web/e2e/server.ts`, `web/e2e/env.ts`).

## Mismatches

- `plans/uploads-to-s3.md` initially proposes purposes `session/calibration/copilot`, `copilotSessionId`, resize-on-read, and soft deletion without S3 deletion. Current code uses `before/during/copilot`, no copilot-session column, upload-time model copies, and hard S3 cleanup on expiry/failure. Its later “As built” section reflects many of these changes (`web/prisma/schema.prisma`, `web/lib/uploads.ts`).
- The upload plan's native copilot PDF decision is superseded by its “As built” note and `pdfAsText` implementation. Copilot gets extracted Markdown; chat gets the PDF link (`plans/uploads-to-s3.md`, `web/lib/copilot-studio.ts`, `web/lib/uploads.ts`).
- Learner report code comments say “for the trainer's team,” but recipients are the fixed TrainerTwin operator addresses, not org team members (`web/components/twin/twin-learner-flow.tsx` `ReportDialog`, `web/lib/issue-alerts.ts`).
- The production release brief labels `web/vercel.json` as region `bom1`; only the root manifest declares that region. Its historical paused-ingestion description must not be read as current pump behavior (`plans/prod-release-v2.md`, both Vercel manifests, `web/lib/ingestion-queue.ts`).
- `docs/README.md` says to deploy by connecting to Mintlify; the repo also has a static-export build and Vercel output/redirect configuration. It does not establish which hosting arrangement is currently active (`docs/package.json`, `docs/vercel.json`).
- `PRODUCT.md` describes an older Pipecat/deterministic architecture and narrow copilot tools without shell/filesystem access. The repo runs a LiveKit voice agent and gives copilot an Eve sandbox. These affect service/deploy understanding; see [Voice agent and chat](voice-agent-and-chat.md) and [Copilot](copilot.md), rather than treating that product text as the platform runtime contract (`ecosystem.config.cjs`, `copilot/agent/sandbox.ts`, `copilot/agent/instructions/copilot.md`).

## Open questions

- **Which Vercel settings are live?** Local studio/chat links name projects, the copilot plan names another, and docs declares a redirect host. The manifests differ on cron coverage and region; the historical release log names branch `v2`. Confirm current project roots, active config, production branches, cron installation, preview secrets and docs hosting in the dashboard (`web/.vercel/project.json`, `chat/.vercel/project.json`, `plans/copilot-v2.md`, `plans/prod-release-v2.md`, root/web/docs `vercel.json`).
- **How do database-less previews pass build validation?** The build comment says previews have no database, while Next config imports an env schema requiring a DB URL unless `SKIP_ENV_VALIDATION` is set. There is no preview-specific exception in that schema (`web/scripts/vercel-build.sh`, `web/next.config.ts`, `web/env.ts`).
- **Should expired content be inaccessible through every reader, and should it be erased?** Resolver checks expiry immediately; view/readDocument require only ready status; raw session reads do not check status/expiry. Cleanup retains extracted text and suppresses S3 deletion errors (`web/lib/uploads.ts`, `web/app/api/uploads/[id]/view/route.ts`, `web/app/api/copilot/studio/route.ts`, `web/app/api/documents/[id]/raw/route.ts`).
- **Should membership gates agree?** Generic `uploader`'s member lookup has no `disabledAt` filter, while copilot start and non-owner preview require enabled membership. The portal resolver supplies a signed-in user without checking org membership (`web/lib/upload-access.ts`, `web/lib/session-user.ts`, `web/lib/org.ts` `getTrainerOrg`, view route). This is not proof that every disabled-account path is reachable; [Authentication](auth.md) owns sign-in disabling.
- **What guarantees should operators have for alerts and metering?** Reports persist without replay/session columns or an alert outbox, and model usage posts have only bounded in-memory retries. Current behavior is best effort, not exactly-once end-to-end delivery (`web/app/api/issues/route.ts`, `web/prisma/schema.prisma`, `chat/agent/lib/usage.ts`, `copilot/agent/lib/usage.ts`).

## Tests today

### Setup and commands

Run web commands from `web/` (`web/package.json`, `web/bunfig.toml`):

| Command | What runs |
| --- | --- |
| `bun run test:setup` | `scripts/test-db-setup.ts`: derive local `<dev DB>_test`, create if missing, apply migrations. Does not drop/reset the dev or test database. |
| `bun run test` | `bun test --parallel tests`. |
| `bun run test:unit` | Parallel tests excluding `**/*.db.test.ts` and `tests/flows/**`; filename exclusions are not proof every remaining file is DB-free. |
| `bun run test:db` | `bun test --parallel .db.test`. |
| `bun run test:flows` | `bun test --parallel tests/flows`. |
| `bun run test:e2e` | `playwright test`; optional persistent server: `bun run e2e:server`. |

Bun preloads `web/tests/setup/preload.ts` in each parallel worker. It derives the test URL, assigns **both** database variables, or removes `DATABASE_URL` when it cannot derive one. `testDatabaseUrl` accepts only localhost/127.0.0.1, appends `_test` once and preserves other URL parts. Many DB suites use local/real-DB guards, such as `web/tests/lib/minutes-test-db.ts`, and skip otherwise; these are test guards, not a sandbox for every script (`web/tests/setup/test-db-url.ts`). `.env.test` supplies fake Razorpay/LiveKit/chat configuration and blanks email/S3 buckets; it does not itself blank every credential (`web/.env.test`).

Flows call real app helpers/routes against the real test DB, using UUID fixtures with cleanup. MSW answers Razorpay, Resend, LiveKit and chat HTTP calls and records requests. `flow-env.ts` sets a fake Resend key before email-module import. The harness suppresses Next `after()` work, so reports/LLM/background alerts are not exercised by those flows. Unhandled requests are recorded for explicit assertions (`web/tests/flows/harness.ts`, `flow-env.ts`, `web/tests/lib/minutes-test-db.ts`, `web/tests/flows/credit-purchases.flow.test.ts`).

Playwright uses installed Chrome, one worker because specs share seeded data, 60-second test / 15-second assertion timeouts, retained failure traces and failure screenshots. It starts or reuses a Next dev server on 3999 with `.next-e2e` output and the derived test DB. A setup project reseeds the known E2E org, signs admin/learner/out-of-credits users in through the auth API, saves cookies, and warms pages before specs. Reseeding deletes only that fixture's prior rows, not the whole DB (`web/playwright.config.ts`, `web/e2e/env.ts`, `server.ts`, `seed.ts`, `seed.setup.ts`). E2E overrides disable email and use fake LiveKit/chat/payment settings, but are not the MSW flow harness.

### Coverage by layer

- **Unit/helpers:** `web/tests/lib/context-upload.test.ts` and `during-upload.test.ts` cover purpose policy/settings and exact size boundaries; `context-document-service.test.ts` covers preparation, MIME rejection, image dimensions, chunk search and manifests. `s3.test.ts` checks org-rooted keys, not AWS operations. `usage.test.ts` uses a fake DB and tests delta deduplication, snapshot recovery/staleness, cross-org identity, usage adapters, schema validation and HTTP authentication/errors. `issue-alerts.test.ts` injects PostHog/email/session fakes and checks event fingerprint, links, recipients, no-PostHog and unknown-call behavior (`web/tests/lib/`).
- **API tests:** `web/tests/api/upload.test.ts` exercises the legacy multipart permission path with mocked storage: matching invite, wrong recipient, used/expired/inactive/spent links, and member access. It is not an S3 presigned round trip.
- **DB:** no dedicated upload/usage/issue `*.db.test.ts` suite was found. `web/tests/lib/persona-analysis-queue.test.ts` includes real-local-DB queue checks despite lacking that suffix; production backfill behavior also crosses the knowledge/persona boundary.
- **Flows:** `web/tests/flows/credit-purchases.flow.test.ts`, `credits-purchase-practice.flow.test.ts`, `org-topup.flow.test.ts`, `trainer-credits.flow.test.ts`, `reconcile-purchases.flow.test.ts`, `reconcile-purchases-script.flow.test.ts` validate financial/session journeys using shared infrastructure, not the new upload/issue/analytics lifecycle.
- **Browser:** `web/e2e/credits.spec.ts`, `payments.spec.ts`, `learner.spec.ts`, `trainer-credits.spec.ts` cover studio/learner credit/payment UI. No dedicated presigned-upload, issue-alert, or PostHog browser suite was found.
- **Other runtimes:** `agent/tests/test_usage.py` tests voice snapshot collection/delivery and learner-presence timing; `chat/tests/agent/usage.test.ts` tests usage conversion/posting and completed-call instrumentation; `chat/tests/agent/instrumentation.test.ts` checks Langfuse session grouping. Chat runs `bun test tests/` (`chat/package.json`); agent uses pytest (`agent/pyproject.toml`). Copilot's command runs `node --test test/sandbox.node.mjs && bun test test/`; its `test/copilot-v2.test.ts` is not a dedicated usage-delivery suite (`copilot/package.json`).

Important untested rules in the files above: real S3 signed length/type enforcement and browser CORS; presigned start/complete/view/expiry authorization and failures; failed deletion leftovers; expiry versus every reader; usage uniqueness/cursor concurrency on PostgreSQL; issue route validation/attribution plus real background delivery; cron auth and both manifest configurations; PostHog identity/pageviews and server-client lifecycle; production/preview build branches and live Vercel wiring. These need tests or operational checks, not assumptions based on the helper tests.
