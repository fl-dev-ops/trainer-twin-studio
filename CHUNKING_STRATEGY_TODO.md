# Ingestion and Chunking Strategy TODO

Status: Milestone 1 Notion ingestion is implemented. The remaining items in this document are intentionally deferred.

## Current baseline

- Postgres is the canonical catalog for knowledge bases, documents, sources, connections, and ingestion jobs.
- S3 stores source material and normalized Markdown.
- ChromaDB stores one record per chunk and its embedding.
- `web/lib/knowledge.ts:chunkMarkdown()` is the active heading-aware Markdown chunker.
- Notion pages use the existing Markdown chunker. Do not add semantic chunking to Notion until retrieval measurements justify it.
- Every Chroma record includes `docId`, `source`, `chunkIndex`, and `chunkCount`.
- A Notion connection is both organization-scoped and authorizing-user-scoped. Its API tokens are encrypted at rest and are never returned to the browser.

## Target flow

```text
Connected source URL
   -> source adapter
   -> normalized IngestionDocument
   -> chunking strategy factory
   -> Chunk[]
   -> optional topic classification
   -> embeddings
   -> ChromaDB
```

The factory seam becomes real only when YouTube is added. Until then, keep the Notion adapter concrete.

## Milestone 1: Notion ingestion

Implemented module interface:

```ts
queueNotionSync(kbSlug, sourceUrl, connectionId) -> IngestionJob
listNotionImports(kbSlug) -> { connections: NotionConnection[]; jobs: IngestionJob[] }
runNextNotionJob() -> boolean
```

### Connection and ownership model

Notion uses a public OAuth integration. The browser redirects to Notion only through the application OAuth start route; trainers never paste access tokens.

```text
Authenticated trainer in organization
  -> Notion OAuth connection
  -> NotionConnection(orgId, userId, workspaceId)
  -> KnowledgeSource -> NotionSourceConfig(connectionId)
  -> KnowledgeDocument
```

`NotionConnection` stores `workspaceId`, optional display metadata, `botId`, `accessTokenCiphertext`, and optional `refreshTokenCiphertext`. Its uniqueness boundary is `(orgId, userId, workspaceId)`. Every read, queue, worker claim, and source lookup must be scoped to the current organization; the OAuth callback additionally binds the connection to the authenticating user. Decrypt only immediately before an API request and never log token values.

Implementation responsibilities:

1. Start public OAuth from a selected knowledge base and retain the state needed to return there safely.
2. Exchange the authorization code server-side, encrypt tokens, and upsert the organization/user/workspace connection.
3. Parse the root page ID from a Notion URL.
4. Upsert one `KnowledgeSource` for the root page and selected connection.
5. Create a durable `IngestionJob`.
6. A database-polling worker atomically claims one queued job.
7. Traverse nested blocks and collect `child_page` IDs recursively.
8. Retrieve each page as enhanced Markdown with that source connection's token.
9. Store Markdown in S3 and upsert one `KnowledgeDocument` per Notion page.
10. Reuse `digestKnowledge()` and `ingestDoc()` for chunking, embedding, and Chroma indexing.
11. Skip re-indexing when Notion's `last_edited_time` is unchanged.
12. Record job progress and errors in Postgres.

Retry policy stays deliberately small:

```text
attempt 1 -> 500 ms
attempt 2 -> 2,000 ms
attempt 3 -> 4,500 ms
```

Retry network failures, HTTP 429, and HTTP 5xx. Do not add jitter, distributed rate limiting, or a separate retry queue until the simple policy is insufficient.

Known follow-ups:

- Decide whether pages missing on resync should remain indexed, become stale, or have their Chroma rows removed.
- Support refresh-token rotation only if the Notion OAuth response/application configuration supplies it.
- Evaluate whether transient signed media URLs inside enhanced Markdown need asset copying into S3.
- Add cancellation and resume checkpoints only if real jobs are large enough to need them.
- Decide whether meeting-note transcripts should use `include_transcript=true`.

## Milestone 2: Source Adapter factory

Add this seam only when the YouTube adapter is implemented:

```ts
type SourceType = "notion" | "youtube";

type IngestionDocument = {
  externalId: string;
  parentExternalId: string | null;
  title: string;
  sourceUrl: string;
  text: string;
  contentType: "markdown" | "transcript";
  updatedAt: Date | null;
  metadata: Record<string, string | number | boolean>;
};

interface IngestionAdapter {
  discover(source: KnowledgeSource): AsyncIterable<IngestionDocument>;
}

function createIngestionAdapter(type: SourceType, dependencies: AdapterDependencies): IngestionAdapter;
```

Factory rules:

- The route and worker know only `SourceType` and the adapter interface.
- Authentication, pagination, traversal, and provider response shapes stay inside each adapter.
- Adapters return normalized documents; they do not write S3, Postgres, or Chroma.
- The ingestion module owns organization scoping, persistence, idempotency, progress, and failures.
- Unknown source types fail immediately. Do not silently select a default adapter.

## Milestone 3: Chunking strategy factory

Create a second factory after there are at least two real strategies:

```ts
type ChunkingStrategyName = "markdown-structural" | "transcript-semantic";

interface ChunkingStrategy {
  chunk(document: IngestionDocument): Promise<Chunk[]>;
}

function createChunkingStrategy(name: ChunkingStrategyName): ChunkingStrategy;
```

### Markdown structural strategy

Use for:

- Notion enhanced Markdown
- uploaded Markdown
- documents converted to Markdown by Anydoc

Behavior:

- Prefer heading and paragraph boundaries.
- Preserve the nearest heading as chunk context.
- Split oversized paragraphs on sentence boundaries.
- Enforce the embedding model's maximum input size.
- Add optional overlap only after retrieval evaluation demonstrates boundary loss.

Keep the existing implementation until benchmark data shows a regression.

### YouTube transcript semantic strategy

Use Chonkie `SemanticChunker` for timestamped, weakly structured speech transcripts.

Pipeline:

```text
YouTube URL
  -> video metadata
  -> authorized caption track or approved transcription provider
  -> timestamped transcript segments
  -> sentence normalization
  -> Chonkie SemanticChunker
  -> map semantic spans back to start/end timestamps
  -> optional overlap refinement
  -> embeddings + ChromaDB
```

Required metadata per chunk:

```json
{
  "sourceType": "youtube",
  "videoId": "...",
  "sourceUrl": "...",
  "title": "...",
  "language": "en",
  "startSeconds": 120.4,
  "endSeconds": 173.8,
  "chunkIndex": 3,
  "chunkCount": 12
}
```

Implementation requirements:

- Preserve chronological order; never group non-contiguous transcript sentences into one chunk.
- Keep timestamps outside the embedded text but inside metadata.
- Choose one embedding model for semantic boundary detection and final Chroma embeddings where practical.
- Measure chunk size distribution, boundary coherence, embedding cost, and retrieval quality before enabling by default.
- Cap chunks for the embedding model even when semantic similarity would produce a larger span.
- Do not assume the official YouTube API can download captions for arbitrary public videos. `captions.list` and `captions.download` require OAuth and sufficient permission.
- For videos not owned or authorized by the connected user, select a compliant transcript provider or permitted audio-to-text path before coding.

Chonkie adoption checklist:

- Confirm the current `@chonkiejs/core` version and Bun compatibility.
- Record the semantic chunker configuration in source metadata for reproducible re-indexing.
- Compare `SemanticChunker` against `SentenceChunker` on representative transcripts.
- Consider `OverlapRefinery` only if timestamp mapping remains deterministic.
- Do not reuse embeddings returned by a refinery unless their model and dimensions exactly match the Chroma collection.

## Milestone 4: Topics

Postgres remains the canonical topic taxonomy.

Suggested models:

- `Topic`: `id`, `slug`, `label`, `description`, `status`, timestamps.
- `DocumentTopic`: normalized document-to-topic relation with confidence and classifier version.
- Store approved topic slugs as a string array in Chroma chunk metadata.

Classification flow:

```text
complete normalized document
  -> document-level open pass proposes topics
  -> proposed topics await approval
  -> chunk-level closed-set batched classification
  -> approved topic slugs stored on each Chroma row
```

Rules:

- New LLM-proposed topics start as `proposed`; do not activate them silently.
- Closed-set chunk classification may return `unclassified`.
- Store classifier model, prompt version, confidence, and classified timestamp.
- Log `[LLM:topic-classification]` start, completion, elapsed milliseconds, model, and chunk count without document text.
- Topic filtering is optional at query time. No topic filter means current retrieval behavior.
- Use Chroma `$contains` for a topic slug stored in an array field.

## Idempotency and resync

- Source identity: `(kbId, sourceType, rootExternalId, connectionId)`.
- Document identity: `(sourceId, externalId)`.
- Chroma identity: `${documentId}#${chunkIndex}`.
- Re-indexing deletes/replaces only chunks belonging to that document ID.
- Store chunker name, chunker version, and configuration hash before multiple strategies are enabled.
- A changed strategy requires explicit re-indexing; never mix configurations invisibly within one document.

## Observability

Required prefixes:

- `[EXT-API:notion]`: endpoint path, attempt, status, elapsed milliseconds, error.
- `[EXT-API:youtube]`: operation, video ID, status, elapsed milliseconds, error.
- `[JOB:notion-sync]` and `[JOB:youtube-sync]`: job ID, source ID, progress, elapsed milliseconds, error.
- `[LLM:topic-classification]`: model, batch size, elapsed milliseconds, error.

Never log tokens, transcript/document bodies, presigned URLs, or trainer data.

## Verification sequence for future milestones

1. Prisma generate and migration validation.
2. TypeScript typecheck with no new errors.
3. ESLint on touched files with no new warnings.
4. Next production build.
5. Manual source import using a small fixture.
6. Confirm S3 object, Postgres document/job rows, Chroma row count, chunk metadata, and retrieval.
7. Run one unchanged resync and confirm no duplicate documents or chunks.
8. Run one changed resync and confirm only that document is replaced.

## Primary implementation sources

### Notion

- Retrieve enhanced Markdown: https://developers.notion.com/reference/retrieve-page-markdown
- Work with enhanced Markdown: https://developers.notion.com/guides/data-apis/working-with-markdown-content
- Read nested blocks and `child_page` blocks: https://developers.notion.com/guides/data-apis/working-with-page-content
- Request limits: https://developers.notion.com/reference/request-limits
- Public OAuth connections: https://developers.notion.com/guides/get-started/public-connections
- Authorization and capabilities: https://developers.notion.com/guides/get-started/authorization
- Page-content webhooks for a later sync trigger: https://developers.notion.com/reference/webhooks/page-content-updated

### YouTube

- YouTube Data API reference: https://developers.google.com/youtube/v3/docs
- Caption track listing: https://developers.google.com/youtube/v3/docs/captions/list
- Caption download: https://developers.google.com/youtube/v3/docs/captions/download
- Caption implementation and OAuth requirements: https://developers.google.com/youtube/v3/guides/implementation/captions

### Chunking and retrieval

- Chonkie JavaScript quick start: https://docs.chonkie.ai/oss/quick-start
- Chonkie SemanticChunker: https://docs.chonkie.ai/oss/chunkers/semantic-chunker
- Chonkie refinery overview: https://docs.chonkie.ai/oss/refinery/overview
- Chonkie source repository: https://github.com/chonkie-inc/chonkie
- Chroma metadata array filtering: https://docs.trychroma.com/docs/querying-collections/metadata-filtering
