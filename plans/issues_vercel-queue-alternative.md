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

## 3. Alternatives Under Evaluation

### Alternative A: PostgreSQL-Native Queue / `SKIP LOCKED` (RECOMMENDED)
- **Concept:** Leverage our existing Neon PostgreSQL database for both local dev and production.
- **Mechanism:**
  - When a persona source is uploaded, mark `PersonaSource.status = 'queued'`.
  - A simple polling loop or background pump retrieves jobs safely using `SKIP LOCKED`:
    ```sql
    SELECT id FROM "PersonaSource"
    WHERE status = 'queued'
    ORDER BY "createdAt" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
    ```
  - Analyzes the source inside the existing transaction advisory lock (`pg_advisory_xact_lock(76110401)`).
- **Why this is the best fit:**
  - **Identical Behavior Everywhere:** Works on `localhost` exactly the same as in production.
  - **Zero New Dependencies:** No Redis, no SQS, no `@vercel/queue`.
  - **Guaranteed Rate-Limit Protection:** Single-flight processing continues to protect OpenRouter from concurrency limits.

### Alternative B: Queue Abstraction with Local Fallback
- **Concept:** Retain `@vercel/queue` in production, but wrap the dispatcher:
  ```ts
  if (process.env.NODE_ENV === "development" || !process.env.VERCEL) {
    // Local: immediate in-process async queue or immediate pump trigger
  } else {
    // Production: send to @vercel/queue
  }
  ```
- **Trade-off:** Keeps `@vercel/queue` in production, but maintains two separate execution paths.

### Alternative C: External Queue (BullMQ / Redis / SQS)
- **Concept:** Stand up Redis (Upstash) or AWS SQS.
- **Trade-off:** Over-engineered for serializing single-digit persona source uploads; introduces unnecessary infrastructure costs.

---

## 4. Scope & Decisions

1. **Core Objective:** Eliminate local `@vercel/queue` failures and build warnings while preserving serialized single-flight LLM execution to prevent OpenRouter 429 rate-limiting.
2. **Requirements:**
   - Uploading 20+ persona documents at once must process sequentially without overloading OpenRouter.
   - Zero `[QueueClient] Region not detected` warnings during local development, build, or tests.
   - Seamless local execution under `bun dev`.

---

## 5. Verification Checklist (Definition of Done)

- [ ] Decision finalized: Adopt PostgreSQL `SKIP LOCKED` / state polling OR implement local dev queue abstraction.
- [ ] `@vercel/queue` package removed or guarded from running in local/build environments.
- [ ] No `[QueueClient] Region not detected` warnings in terminal or build logs.
- [ ] Bulk upload test: Upload 15+ transcripts to a persona locally; all transition `queued` → `analyzing` → `analyzed` without 429 rate limit errors or timeouts.
- [ ] Single-flight concurrency verified: OpenRouter receives only 1 persona analysis request at a time.
- [ ] Production Vercel deployment builds cleanly and passes cron pump/queue verification.
