Recommended direction

Selectively port the PR’s ingestion engine, but make current main authoritative for tenancy,
storage, authentication, retrieval, and UI.

Use one ingestion model for all sources:

```text
  Upload / Notion / YouTube
          ↓
  KnowledgeSource
          ↓
  IngestionJob → IngestionWorkItem
          ↓
  SQS
          ↓
  ingestion-pipeline Lambda
          ↓
  S3 + org-scoped Chroma main collection
```

What to bring from the PR

Bring largely intact:

- ingestion-pipeline/**
- shared/chunking/**
- shared/openrouter/**
- shared/youtube/**
- Identifier-only SQS contract:
  ```json
    {"jobId":"...","workItemId":"..."}
  ```
- Work-item leases, duplicate-delivery protection, retries, DLQ handling
- Notion traversal/chunking
- YouTube OAuth, caption processing, segmentation, question extraction and artifacts
- Topic extraction/reconciliation logic

Do not bring:

- PR Prisma schema or its migration chain
- PR replacements for web/lib/knowledge.ts, web/lib/specs.ts, or web/lib/s3.ts
- Old knowledge-manager.tsx architecture
- Benchmark reports/fixtures
- Unrelated auth, session, or runtime changes
- The PR’s slug-based Chroma collections

The temporary credential can be ignored; bench/** will not be imported anyway.

────────────────────────────────────────────────────────────────────────────────

Implementation plan

Phase 0 — Isolate the work

The current checkout contains unrelated runtime changes. Implement this in a separate worktree based
on current main (f9b9038), then merge after the current work is committed.

Use a new migration timestamp later than the existing untracked:

```text
  20260910050000_interview_runtime_state
```

Phase 1 — Import the worker baseline

Copy:

```text
  ingestion-pipeline/
  shared/chunking/
  shared/openrouter/
  shared/youtube/
```

Initially preserve the worker’s handler, adapter dispatch, work leases, YouTube segment/publish
flow, and artifact formats.

Required baseline checks:

```bash
  cd ingestion-pipeline
  bun install
  bun run build
  bun run smoke
```

This phase should not connect the worker to production yet.

Phase 2 — Add one additive schema migration

Merge only the ingestion data model into the current Prisma schema.

### Add

- KnowledgeSource
- IngestionJob
- IngestionWorkItem
- NotionConnection
- NotionOAuthState
- YouTubeConnection
- YouTubeOAuthState
- NotionSourceConfig
- YouTubeSourceConfig
- Topic / TopicStatus

### Extend KnowledgeDocument

Add:

- sourceId
- externalId
- externalUpdatedAt
- parentExternalId
- s3QuestionsKey

Make s3MarkdownKey nullable because YouTube stores transcript.json and questions.json.

Preserve:

- KnowledgeBase @@unique([orgId, slug])
- Current organization/session/persona relations
- Organization.chromaTenantId
- Organization.chromaDatabase

Existing uploaded documents can retain sourceId = null. When an old document is reindexed, lazily
create its upload source.

Do not replay the PR’s eight historical migrations; produce one migration against the current
schema.

Phase 3 — Add the web → SQS boundary

Port and adapt:

```text
  web/lib/ingestion-message.ts
  web/lib/ingestion-queue.ts
```

Add @aws-sdk/client-sqs to web/package.json.

Create one server helper responsible for:

1. Creating/finding the KnowledgeSource
2. Coalescing an existing active job
3. Creating the root work item
4. Committing those rows
5. Sending the identifier-only SQS message
6. Setting enqueuedAt after successful publication

No URLs, tokens, organization IDs, Markdown, or connector configuration should enter SQS. The worker
must derive everything from PostgreSQL.

Add recovery for committed work items where:

```text
  status = queued AND enqueuedAt IS NULL
```

A small scheduled outbox pump can republish them safely.

Phase 4 — Move current file indexing to SQS

Add an upload adapter to the worker—the only new adapter not already in the PR.

### Web request remains responsible for

- Authentication
- File validation
- Firecrawl/Anydoc conversion
- Writing source and Markdown to S3
- Creating the document/source/job/work-item
- Returning 202 Accepted

### Worker becomes responsible for

- Reading Markdown from S3
- Chunking
- Embedding
- Publishing vectors
- Updating document/job status

Refactor:

- web/lib/org-knowledge.ts
- web/lib/specs.ts
- /api/knowledge/upload
- /api/knowledge/documents/[id]
- Legacy digest route

Both dashboard and legacy APIs should call the same queue helper rather than maintaining separate
synchronous index paths.

### Status lifecycle

```text
  uploaded → queued → digesting → indexed
                              ↘ failed
```

Reindex should return:

```json
  {
    "ok": true,
    "jobId": "...",
    "documentId": "...",
    "status": "queued"
  }
```

It should no longer wait for or return a final chunk count.

Phase 5 — Adapt the worker to current storage

This is the primary mandatory deviation from “as-is.”

### Chroma

The PR writes to:

```text
  kb_<slug>
  kb_<slug>_questions
```

Replace that boundary with current main behavior:

- Read Organization.chromaTenantId and chromaDatabase
- Use the organization’s dedicated tenant/database
- In shared mode, use org_<orgId>_main
- Write current metadata:
    - type
    - orgId
    - kbId
    - docId
    - source
    - title
    - chunkIndex

Do not provision Chroma inside Lambda. The authenticated web producer should ensure the
organization’s Chroma scope exists before queueing.

### YouTube questions

Keep the PR’s segmentation, extraction, S3 question artifact, question type, difficulty, code,
context, and timestamps.

Publish question vectors into the organization’s current main collection with:

```text
  type = knowledge
  kind = youtube_question
```

This makes them immediately visible to existing search and runtime retrieval without introducing a
second retrieval system.

### S3

Replace the PR’s slug-based path:

```text
  <base>/<orgId>/<kbSlug>/<docId>
```

with current immutable paths:

```text
  <base>/knowledge/<kbId>/<docId>
```

Phase 6 — Treat Notion and YouTube as connectors

The generic abstraction should stop at:

- Source
- Job/work item
- Queue contract
- Status projection
- Refresh/delete lifecycle
- Worker adapter interface

Keep provider-specific OAuth and acquisition code as normal modules. Do not build a plugin SDK or
JSON-driven connector framework.

### Connection ownership

Connections should be organization-owned, with the authorizing user retained only for audit:

```text
  orgId
  authorizedByUserId
  provider account/workspace/channel ID
  encrypted credentials
  status
```

This prevents an integration from becoming unusable merely because the original admin leaves.

Separate Notion and YouTube connection tables are acceptable and require fewer worker changes than a
generic credentials table.

### Authorization

All connector management routes should use:

```ts
  getTrainerOrg()
```

Only owners/admins should be able to:

- Connect
- Import
- Refresh
- Disconnect
- Delete sources
- View integration state

OAuth state must be single-use, expire after ten minutes, and bind:

- Organization
- Initiating user
- Knowledge base
- Provider
- YouTube PKCE verifier where applicable

Callbacks must re-check that the user remains an owner/admin in that exact organization.

Phase 7 — API shape

Recommended routes:

```text
  GET    /api/knowledge/connectors
  POST   /api/knowledge/connectors/notion
  POST   /api/knowledge/connectors/youtube/preview
  POST   /api/knowledge/connectors/youtube

  POST   /api/knowledge/sources/[id]/refresh
  DELETE /api/knowledge/sources/[id]
  DELETE /api/knowledge/connections/[id]

  POST   /api/connectors/notion/oauth/start
  GET    /api/connectors/notion/oauth/callback
  POST   /api/connectors/youtube/oauth/start
  GET    /api/connectors/youtube/oauth/callback
```

Notion can expose both:

- Connected workspace import
- Public page URL import

The latter is a source import, not an OAuth connection.

Phase 8 — Integrate with the current Knowledge UI

Modify the current aggregate screen under:

```text
  web/components/knowledge/
```

Do not port the PR’s old manager layout.

Add:

- Add source dialog
- Upload / Notion / YouTube choices
- Connector badges on documents
- Source-level sync state and errors
- “Refresh source” for connector documents
- “Re-index” only for uploaded files
- Connection management within the Add Source dialog
- Destructive disconnect confirmation showing affected sources/documents

Use TanStack Query polling only while jobs are active:

```text
  queued | running | syncing | deleting | disconnecting
```

Stop polling at terminal states and invalidate documents, stats, chunks, and 3D data after
completion.

Phase 9 — Cleanup and race safety

Before enabling connectors:

- Fix removeDocumentStrict; rejected Chroma deletions must propagate.
- Paginate S3 deletion beyond 1,000 objects.
- Cancel queued work before source/document deletion.
- Prevent a running worker from republishing after deletion.
- Ensure Notion refresh removes pages deleted from the imported subtree—but only after the complete
  crawl succeeds.
- Provision an actual YouTube maintenance schedule; do not show “cleanup queued” while maintenance
  is disabled.
- Preserve the last successful index during failed refreshes.


Validation gates

Minimum critical tests:

1. Current schema migrates without losing existing data or indexes.
2. Existing uploaded documents still list, preview, search, reindex, and delete.
3. Upload returns 202 before embeddings finish.
4. Duplicate SQS messages publish one final vector set.
5. Failed SQS publication is recovered by the outbox pump.
6. Same KB slug in two organizations cannot collide.
7. Current runtime search retrieves worker-ingested Notion content.
8. Current runtime search retrieves YouTube questions.
9. OAuth callbacks reject replay, expiry, removed members, and cross-org use.
10. Failed refresh preserves the previous successful vectors.
11. Delete during an active job cannot recreate vectors.
12. Disconnect removes tokens, S3 artifacts, documents, and vectors.
13. Notion child pages fan out and reconcile correctly.
14. YouTube segment publication waits for every segment.
15. DLQ/max-receive behavior produces a visible failed job.

Suggested delivery slices

1. Foundation: worker import, shared modules, schema, queue contract
2. Async uploads: upload adapter and current upload/reindex cutover
3. Notion connector: OAuth/public import, traversal, refresh, reconciliation
4. YouTube connector: OAuth, captions, question extraction, publication
5. Cleanup and operations: outbox, retention, disconnect, deletion, DLQ
6. UI and canary: Add Source experience, polling, one-org staged rollout
