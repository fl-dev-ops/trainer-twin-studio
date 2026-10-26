# TrainerTwin Copilot (scenario ingest)

[eve](https://eve.dev) agent that builds role-play scenarios from a trainer's recorded sessions and
method material. It replaced the earlier spec-design copilot; the folder, deployment, web proxy
(`/api/eve/v1`) and org authentication are unchanged.

For each scenario it writes `SKILL.md`, `scenario.json`, `items.json` and `patterns.md`, checks them,
and publishes. The web app stores what it publishes: S3 keeps the files, Postgres the runnable
scenario, Chroma the items the trainer's twin retrieves in sessions (see `web/lib/scenario-ingest.ts`).

- `agent/` instructions, tools, the `build-scenario` skill and `lib/` (sources, checks, publication)
- `agent/channels/eve.ts` org authentication for the web proxy (`orgId:COPILOT_SERVICE_SECRET`)
- `agent/instrumentation/` usage metering to the web ledger
- Sources: `users/<user>/` in `INGEST_S3_BUCKET`, or `INGEST_USERS` locally (see `.env.example`)

```bash
bun install
bun run dev        # eve dev
bun run typecheck
bun run test
```
