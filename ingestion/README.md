# Knowledge ingestion worker

Processes files users upload to their knowledge base in the web app. One SQS message = one file.

```
web upload -> S3 (original) -> SQS -> worker: download -> markdown -> redact PII -> chunk -> embed
                                             -> POST results -> web: S3 (markdown, chunks) + org Chroma
```

The worker has no Postgres, S3 or Chroma credentials. It gets a signed URL for the file and sends its
results back to the web app (`web/app/api/internal/ingestion/results/route.ts`).

## Pipeline (Chonkie as the base)

```
FileFetcher -> redacted_markdown -> SlumberChunker -> merge_small -> EmbeddingsRefinery -> JSON porter
```

| Step | How |
|---|---|
| Convert | `.md/.txt/.json` as-is; Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF via [anydoc](https://github.com/firecrawl/anydoc) (scanned PDFs: Firecrawl Parse OCR); audio/video via AssemblyAI with speaker labels; images via a vision model on OpenRouter |
| Redact | `vendor/pii_redact.py`: one LLM call per block (Qwen on OpenRouter) lists the PII, code replaces exact matches with `[PERSON_1]`-style placeholders. Any unchecked block fails the file |
| Chunk | Chonkie `SlumberChunker`: Qwen (reasoning off) picks each topic boundary, at most 1000 words per chunk |
| Merge | chunks under 150 words join a neighbour, re-sliced from the markdown |
| Embed | `openai/text-embedding-3-small` via OpenRouter, once; the web app stores these vectors as-is |

No model runs locally.

## Contract

Message (sent by `web/lib/ingestion-queue.ts` `queueKnowledgeFile`):

```json
{"docId": "...", "orgId": "...", "kbId": "...", "filename": "lesson.m4a", "sourceUrl": "https://… signed GET, 24 h"}
```

Results: POSTs to `INGESTION_RESULTS_URL` with header `x-internal-secret: $INTERNAL_API_SECRET`,
in batches because Vercel caps a request at 4.5 MB:

1. `start`: web clears old chunk files, status `digesting`
2. `chunks` (≤50 per request): web upserts `kb_<docId>#<index>` into the org's `main` collection with the given
   embeddings and stores `ingest/files/<docId>/chunks/part-NNNN.jsonl`
3. `complete`: web stores `ingest/files/<docId>/content.md`, removes chunks beyond the new count, status `indexed`
4. `failed` (`final` on the last SQS attempt): web records the error; `final` sets status `failed`

Every step is idempotent, so SQS retries are safe. A 404 means the document was deleted; the message is dropped.
Give the queue a redrive policy (DLQ) with `maxReceiveCount` = `INGESTION_MAX_RECEIVE_COUNT` (default 5).
Visibility is extended every 150 s while a file runs; one file at a time per process, scale with processes.
Signed URLs are never logged.

## Run

```bash
uv sync
uv run ingestion-worker                     # needs the env below
uv run ingest FILE... --org O --kb K --out DIR   # local run, writes the .md and .chunks.jsonl
uv run pytest -q                            # offline: LLM, embeddings, redaction, SQS and HTTP are faked
```

Env: `INGESTION_QUEUE_URL`, `INGESTION_RESULTS_URL` (e.g. `https://<app>/api/internal/ingestion/results`),
`INTERNAL_API_SECRET` (same value as the web app), `OPENROUTER_API_KEY`, `ASSEMBLYAI_API_KEY` (audio/video),
AWS credentials for SQS; optional `FIRECRAWL_API_KEY` (scanned PDFs), `CHUNK_MODEL`, `EMBEDDING_MODEL`
(must match the web app's), `OCR_MODEL`, `INGESTION_MAX_RECEIVE_COUNT`.

The TypeScript worker that used to live here (Notion, YouTube, interview questions, topic tags) is in git history.
