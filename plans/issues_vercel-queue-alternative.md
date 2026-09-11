# Issue 7: `@vercel/queue` Local Development Alternative or Removal

## 1. Context & Origin (Why `@vercel/queue` Was Introduced)

During bulk document ingestion on `/personas/Vasanth`, uploading 22 persona content files concurrently triggered 22 unmetered background calls to OpenRouter (`google/gemini-2.5-flash`). This triggered severe rate-limiting (HTTP 429) and concurrent request throttling, causing 20 requests to time out after 120s and failing the persona source analysis.

To solve this quickly, two mechanisms were combined:
1. **Serialization Lock:** Added a PostgreSQL transaction advisory lock (`pg_advisory_xact_lock(76110401)`) to ensure strictly **one** persona analysis runs at any given time.
2. **Buffering Queue:** Integrated `@vercel/queue@0.5.1` to accept the 20+ upload requests immediately, return HTTP 200 to the browser, and queue the jobs to be drained sequentially by a Vercel Queue consumer (`/api/queues/persona-analysis`).

---

## 2. The Problem with `@vercel/queue`

While `@vercel/queue` solved the immediate concurrency issue on Vercel production, it created severe developer experience friction:

1. **No Local Offline Emulation:**
   - Vercel Queues are proprietary to Vercel Cloud infrastructure.
   - Running locally (`bun dev` or `next dev`), the client emits continuous warnings:
     ```text
     [QueueClient] Region not detected — defaulting to "iad1". On Vercel this is set automatically via VERCEL_REGION.
     ```
   - Calls to `send()` fail or throw network errors on `localhost`.
2. **Dual-Runner Complexity:**
   - Because `@vercel/queue` does not work locally (and push delivery can lag in production), a secondary polling worker had to be embedded into the 2-minute cron pump (`/api/internal/ingestion/pump` calling `processPersonaAnalysisQueue()`).
   - Having both push queue triggers and pull cron pumps adds architectural clutter.
3. **Vendor Lock-in:**
   - Involves `queue/v2beta` definitions in `vercel.json` and proprietary callback headers (`handleCallback`).

---

## 3. Implemented Solution: PostgreSQL-Native Queue / `SKIP LOCKED` (Alternative A)

- **Architecture:**
  - Removed `@vercel/queue` package completely from `web/package.json` and `bun.lock`.
  - Deleted proprietary Vercel queue consumer endpoint (`web/app/api/queues/persona-analysis/route.ts`) and removed queue trigger configurations from `web/vercel.json`.
  - `enqueuePersonaAnalysis(sourceId, orgId)` marks `PersonaSource.status = 'uploaded'`.
  - `claimNextPersonaSource()` atomically claims the oldest uploaded source using PostgreSQL row-level locks and transaction advisory lock (`pg_advisory_xact_lock(76110401)`):
    ```sql
    SELECT id FROM "PersonaSource"
    WHERE status = 'uploaded'
    ORDER BY "createdAt" ASC
    LIMIT 1
    ```
  - Stale `analyzing` sources (>10m) are automatically recovered back to `uploaded`.
  - `drainPersonaAnalysisQueue()` drains the backlog sequentially in the background, surviving individual failures without halting the queue.

---

## 4. Verification Checklist (Definition of Done)

- [x] Decision finalized: Removed `@vercel/queue` entirely in favor of PostgreSQL-backed serialized queue.
- [x] `@vercel/queue` package removed from `package.json` and `bun.lock`.
- [x] Deleted proprietary `/api/queues/persona-analysis` route and cleaned `vercel.json`.
- [x] No `[QueueClient] Region not detected` warnings in terminal or build logs.
- [x] Unit test suite (`web/lib/persona-analysis-queue.test.ts`) verifies FIFO order, retry tracking, stale row recovery, and sequential drain (7 pass).
- [x] Single-flight concurrency verified: PostgreSQL transaction advisory lock ensures strictly one analysis executes at a time.
