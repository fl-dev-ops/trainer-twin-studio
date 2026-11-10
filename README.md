# TrainerTwin Application

Full-stack interview-trainer studio.

## Architecture

```
application/
├── web/       Next.js studio — Postgres (Prisma) is the source of truth
│   ├── app/                 pages + API routes
│   ├── components/          sidebar shell, spec/knowledge/session UI (Extend viewers)
│   ├── lib/specs.ts         DB-backed spec CRUD + versioning, knowledge upload/digest
│   ├── lib/knowledge.ts     chunking, OpenRouter embeddings, Chroma + hybrid retrieval
│   ├── lib/s3.ts            S3 storage helpers
│   └── prisma/              schema, migrations, seed
├── copilot/   Standalone Eve Spec Copilot — durable chat, tools, and draft workflow;
│              calls the Studio through an authenticated internal API
├── agent/     LiveKit voice agent — joins rooms dispatched by the Studio, fetches
│              compiled specs and hybrid knowledge search results from the studio API
└── web/data/  Legacy YAML/MD seed source (imported by web/prisma/seed.ts)
```

### Knowledge pipeline

1. **Upload + index** — anydoc-supported files (Word, PowerPoint, Excel, OpenDocument,
   RTF, EPUB, CSV, PDF; plus plain .md/.txt) are converted to markdown. Source and markdown
   land in S3 under `S3_BASE_PREFIX/<kb>/<docId>/`, then indexing starts automatically.
2. **Preview** — presigned S3 URLs rendered in-browser with Extend UI viewers
   (PDF/DOCX/PPTX/CSV; text fallback).
3. **Index** — heading-aware paragraph chunks receive OpenRouter embeddings and are upserted
   into one `kb_<slug>` Chroma collection per knowledge base with `{docId, source}` metadata.
   Manual index buttons remain for retry/re-index. Deletion removes that document's vectors.
4. **Retrieval** — the agent calls the studio's hybrid search endpoint: vector ANN + BM25,
   fused with RRF and optionally reranked through OpenRouter.

### Sessions

- Learners open a practice link (`https://<org>.<domain>/s/<shareCode>`) or an integration
  starts a session through `POST /api/v1/sessions`; the Studio dispatches the LiveKit agent
  and returns a participant token (voice) or a runtime token (chat).
- The voice agent joins the LiveKit room, streams the learner over Deepgram STT, and runs
  the interview runtime in `web/lib/runtime` (analyze → deterministic policy → persona
  render) over the Studio's `/api/v1` chat endpoint; responses are spoken through the
  VoxCPM2.
- Evidence coverage streams to the UI; audio egress lands in S3 as the session recording.
- `InterviewSession` rows in Postgres pin the exact persona/agent versions used.

## Run (four processes)

```bash
# 0. Postgres running locally, database `trainertwin` (web/.env has DATABASE_URL)

# 1. Chroma server (used by the studio)
cd application
uvx --from chromadb chroma run --path ./chroma-data --port 8000

# 2. Studio
cd web
bun install
bunx prisma migrate deploy
bun prisma/seed.ts        # first time: imports ../data YAML + knowledge into S3
# .env needs S3 settings, OPENROUTER_API_KEY, CHROMA_URL,
# EVE_ORIGIN=http://localhost:2000, and COPILOT_SERVICE_SECRET
bun run dev               # :3000

# 3. Spec Copilot
cd ../copilot
bun install
cp .env.example .env      # preserve the same COPILOT_SERVICE_SECRET as web/.env
bun run dev               # :2000

# 4. Voice agent
cd ../agent
cp .env.example .env      # LIVEKIT_URL/_KEY/_SECRET, DEEPGRAM_API_KEY, WEB_URL
uv sync
uv run python src/agent.py dev
```

## Sign-in locally

Only existing accounts can sign in (Google or email OTP). Add people from the org's Settings; to provision a new
founder account and onboarding link, run `bun scripts/founder-invite.ts <email>` from `web/`.

Without `RESEND_API_KEY`, `bun run dev` prints the requested OTP in the server terminal as `[Dev sign-in] Code for …`.
Enter that code on the sign-in page. It still expires after 10 minutes and allows 3 attempts. This fallback is
**development-only**; production requires Resend. Treat terminal logs as sensitive and keep dev servers private.

## Billing (Meteroid) locally

Org credits live in Meteroid (`web/lib/org-credits.ts`). Locally the app talks to Meteroid's **Development** tenant
(https://meteroid.foreverlearning.in, tenant "Development"); never to Production.

```bash
# web/.env (see web/.env.example)
METEROID_API_URL=https://meteroid-rest.foreverlearning.in/api/v1
METEROID_API_KEY=pv_dev_...        # Meteroid › Development › Developers › API keys
METEROID_WEBHOOK_SECRET=whsec_...  # from your webhook endpoint below

cd web
bun scripts/meteroid-setup.ts                      # once per tenant (done for Development): MINS, voice_minutes, plan "Credits"
bun scripts/meteroid-link-org.ts --org <slug>      # bill a local org through Meteroid (alias = slug)
```

Webhooks (grants added in Meteroid show up in the app within seconds; without them the Credits page still re-reads
Meteroid every minute). Meteroid can't reach localhost, so each developer runs their own Cloudflare tunnel for the
webhook path only:

```bash
cloudflared tunnel create trainertwin-dev-webhooks-<you>
cloudflared tunnel route dns trainertwin-dev-webhooks-<you> dev-webhooks-<you>.foreverlearning.in
# ~/.cloudflared/trainertwin-dev-webhooks.yml:
#   tunnel: <tunnel id>
#   credentials-file: ~/.cloudflared/<tunnel id>.json
#   ingress:
#     - hostname: dev-webhooks-<you>.foreverlearning.in
#       path: ^/api/meteroid/webhook$
#       service: http://localhost:3000
#     - service: http_status:404
pm2 start ecosystem.config.cjs --only dev-webhooks  # ecosystem starts it whenever that file exists
```

Then in Meteroid › Development › Settings › Webhooks add `https://dev-webhooks-<you>.foreverlearning.in/api/meteroid/webhook`
(events: wallet.funded, wallet.debited, wallet.depleted, wallet.recovered, credit_grant.expired) and put its signing
secret in `METEROID_WEBHOOK_SECRET`.

## Versioning model

- Persona/Agent each carry a `version` int; a changed save snapshots the old data
  into `SpecVersion` (immutable) and increments. The editor restores any snapshot.
- `InterviewSession` rows pin persona/agent versions per session.

## Deployment

The Studio and Copilot are separate deployables. Deploy `copilot/` with `eve deploy`; set its
`STUDIO_URL`, `COPILOT_SERVICE_SECRET`, and model credentials. Deploy `web/` normally; set
`EVE_ORIGIN` to the Copilot URL and use the same service secret. The browser remains same-origin:
Next.js proxies `/eve/v1/*` and never exposes the credential.

## Notes

- Production chunking and retrieval live in `web/lib/knowledge.ts`.
- The agent's LLM calls go through the Studio (`WEB_URL/api/v1`) authenticated with the
  session's runtime token.
- Auth/multi-user and billing are deliberately out of scope for this phase.
