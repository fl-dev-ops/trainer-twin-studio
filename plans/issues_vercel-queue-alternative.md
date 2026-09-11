# Issue 7: `@vercel/queue` Local Development Alternative or Removal

## 1. Context & Problem Statement
`@vercel/queue` is currently used in `web/lib/persona-analysis-queue.ts` and `web/app/api/queues/persona-analysis/route.ts` to enqueue and serialize background persona transcript analysis.

However, `@vercel/queue` has critical limitations for developer workflows:
- **No Local Emulation:** Vercel Queues are proprietary to Vercel's cloud runtime. When running locally via `bun dev` or `next dev`, `@vercel/queue` emits `[QueueClient] Region not detected — defaulting to "iad1"` warnings and calls to `send()` fail or throw network errors.
- **Dual Processing Overhead:** Because queues fail locally and push delivery can be delayed, the codebase already had to implement a dual-runner fallback via the periodic cron pump (`/api/internal/ingestion/pump`).
- **Vendor Lock-in:** The background job contract relies on proprietary Vercel HTTP callback headers (`handleCallback`) and `queue/v2beta` triggers in `vercel.json`.

---

## 2. Alternatives Under Evaluation

### Alternative A: PostgreSQL-Native Queue / `SKIP LOCKED` (RECOMMENDED)
- **Concept:** Leverage the existing Neon PostgreSQL database.
- **Mechanism:**
  - When a persona source is uploaded, set `PersonaSource.status = 'queued'`.
  - A worker or endpoint queries:
    ```sql
    SELECT * FROM "PersonaSource"
    WHERE status = 'queued'
    ORDER BY "createdAt" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
    ```
  - Processes the analysis within the advisory lock (`pg_advisory_xact_lock(76110401)`).
- **Pros:**
  - Zero new infrastructure or dependencies.
  - Runs identically on `localhost` and Vercel production.
  - Complete elimination of `@vercel/queue` package and Vercel queue triggers.

### Alternative B: Queue Abstraction with Local Development Fallback
- **Concept:** Keep `@vercel/queue` for Vercel production, but wrap the queue dispatcher:
  ```ts
  if (process.env.NODE_ENV === "development" || !process.env.VERCEL) {
    // Local: immediate async execution or internal pump
  } else {
    // Production: send to @vercel/queue
  }
  ```
- **Pros:** Preserves existing Vercel queue triggers in production.
- **Cons:** Keeps vendor-specific dual code paths and maintenance overhead.

### Alternative C: External Queue (BullMQ / Redis / SQS)
- **Concept:** Use Redis (Upstash) or AWS SQS.
- **Cons:** Over-engineered for serializing single-digit persona source uploads; introduces unnecessary dependencies and costs.

---

## 3. Scope & Decisions

1. **Primary Goal:** Either find a clean way to run queue processing locally without errors, or remove `@vercel/queue` entirely in favor of a universal PostgreSQL-based state machine.
2. **Key Requirements:**
   - Background persona analysis must work seamlessly when running `bun dev` locally.
   - Analysis must remain serialized via PostgreSQL transaction advisory locking (`pg_advisory_xact_lock(76110401)`) to avoid LLM concurrency rate limits.
   - Remove noisy `[QueueClient] Region not detected` warnings during local development and builds.

---

## 4. Verification Checklist (Definition of Done)

- [ ] Decision finalized: Remove `@vercel/queue` entirely OR implement local runner abstraction.
- [ ] No `[QueueClient] Region not detected` warnings during `bun dev` or `bun run build`.
- [ ] Uploading a persona source locally transitions status from `queued` → `analyzing` → `analyzed` without manual trigger.
- [ ] Multiple concurrent persona source uploads execute in serialized order without 429 rate limit errors from OpenRouter.
- [ ] Production build and deployment passes without proprietary queue dependencies or with verified triggers.
