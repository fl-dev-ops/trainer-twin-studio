# TrainerTwin Copilot

[eve](https://eve.dev) agent that builds from a trainer's knowledge base, through one of two skills. They are different
products and never mixed:

- `twin-creator` (coming): a **twin skill**, the trainer's knowledge, decisions, patterns and approach on one topic,
  which their twin uses to advise learners. Not a role play. See `plans/twin-skill-format.md`.
- `roleplay-creator`: a **role play**, a practice session the AI leads, built from recordings where the trainer runs that
  practice. It writes `SKILL.md`, `scenario.json`, `items.json` and `patterns.md`, checks them and publishes them as a
  role play (web `/api/internal/scenarios`, kind ROLEPLAY; S3 keeps the files, Postgres the agent, Chroma the items).

`agent/instructions.md` holds what both share (which one a request is, sources, privacy); each skill holds its procedure
and the limits its tools enforce.

- `agent/` instructions, tools, the skills and `lib/` (sources, checks, publication)
- `agent/channels/eve.ts` org authentication for the web proxy (`orgId:COPILOT_SERVICE_SECRET`)
- `agent/instrumentation/` usage metering to the web ledger
- Sources: `users/<user>/` in `INGEST_S3_BUCKET`, or `INGEST_USERS` locally (see `.env.example`)

```bash
bun install
bun run dev        # eve dev
bun run typecheck
bun run test
```
