# TrainerTwin Application

Full-stack interview-trainer studio built on the `synthesizer/poc` runtime.

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
├── agent/     Pipecat voice agent — fetches compiled specs and hybrid knowledge search
│              results from the studio API
├── digest/    Chunking/retrieval experiments
└── web/data/  Legacy YAML/MD seed source (imported by web/prisma/seed.ts)
```

### Knowledge pipeline

1. **Upload + index** — anydoc-supported files (Word, PowerPoint, Excel, OpenDocument,
   RTF, EPUB, CSV, PDF; plus plain .md/.txt) are converted to markdown. Source and markdown
   land in S3 under `S3_BASE_PREFIX/<kb>/<docId>/`, then indexing starts automatically.
2. **Notion import** — a trainer connects a Notion workspace through public OAuth, then selects
   a root page to import. A worker recursively discovers child pages, stores normalized Markdown
   in S3, and indexes each page as a document. Connections are scoped to the trainer's organization
   and authorizing user; encrypted OAuth tokens never reach the browser.
3. **Preview** — presigned S3 URLs rendered in-browser with Extend UI viewers
   (PDF/DOCX/PPTX/CSV; text fallback).
4. **Index** — heading-aware paragraph chunks receive OpenRouter embeddings and are upserted
   into one `kb_<slug>` Chroma collection per knowledge base with `{docId, source, chunkIndex,
   chunkCount}` metadata.
   Manual index buttons remain for retry/re-index. Deletion removes that document's vectors.
5. **Retrieval** — the agent calls the studio's hybrid search endpoint: vector ANN + BM25,
   fused with RRF and optionally reranked through OpenRouter.

### Sessions

- The browser connects to the Pipecat agent over SmallWebRTC and sends `start-interview`
  (`personaId`, `agentId`, `contextId`). The context document is uploaded right in the
  session config — it belongs to a session, not to the dashboard.
- Each learner utterance runs the POC runtime (analyze → deterministic policy → persona
  render); responses are spoken via Sarvam TTS. Evidence coverage streams to the UI.
- `InterviewSession` rows in Postgres pin the exact persona/agent/domain versions used.

## Run (four local processes)

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
# EVE_ORIGIN=http://localhost:2000, COPILOT_SERVICE_SECRET, and the Notion OAuth settings below
bun run dev               # :3000

# 3. Spec Copilot
cd ../copilot
npm install
cp .env.example .env      # preserve the same COPILOT_SERVICE_SECRET as web/.env
npm run dev               # :2000

# 4. Voice agent
cd ../agent
cp .env.example .env      # LLM_API_KEY, SARVAM_API_KEY, WEB_URL
uv sync
WEB_URL=http://localhost:3000 uv run python check.py
uv run bot.py -t webrtc   # :7860
```

### Notion OAuth configuration

Create a public Notion integration and set its redirect URL to
`<studio-origin>/api/notion/oauth/callback`. Add these server-only values to `web/.env`:

```bash
NOTION_OAUTH_CLIENT_ID=
NOTION_OAUTH_CLIENT_SECRET=
NOTION_OAUTH_REDIRECT_URI=https://dash.trainertwin.localhost/api/notion/oauth/callback
NOTION_TOKEN_ENCRYPTION_KEY=
NOTION_API_VERSION=2026-03-11
```

Generate `NOTION_TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32`. It must be a stable
production secret; changing it makes previously
stored connection tokens unreadable. Do not expose any Notion credential through `NEXT_PUBLIC_*`
variables or commit it. Trainers connect their own workspace from the knowledge-base page, then
select a root Notion page to import.

### Notion ingestion pipeline

The Studio is an SQS producer: a successful Notion import request creates the durable source,
job, and root-page records, then sends their identifiers to the standard queue. Configure Vercel
with `AWS_REGION`, `INGESTION_QUEUE_URL`, and AWS credentials available through its default
credential chain. The queue's Lambda consumer performs the recursive Notion fetch, S3 persistence,
and indexing; no persistent `web` worker is required.

## Versioning model

- Persona/Agent/Domain each carry a `version` int; a changed save snapshots the old data
  into `SpecVersion` (immutable) and increments. The editor restores any snapshot.
- `InterviewSession` rows pin persona/agent/domain versions per session.

## Deployment

The Studio and Copilot are separate deployables. Deploy `copilot/` with `eve deploy`; set its
`STUDIO_URL`, `COPILOT_SERVICE_SECRET`, and model credentials. Deploy `web/` normally; set
`EVE_ORIGIN` to the Copilot URL and use the same service secret. The browser remains same-origin:
Next.js proxies `/eve/v1/*` and never exposes the credential.

## Notes

- Production chunking and retrieval live in `web/lib/knowledge.ts`; `digest/` holds experiments.
- The agent imports the POC directly (`POC_PATH`, default `../../synthesizer/poc`).
- Organization-scoped authorization applies to knowledge bases, Notion connections, and imports.
