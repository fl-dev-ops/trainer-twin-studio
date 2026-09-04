# Utility Methods

> Auto-maintained by the `extract-utilities` skill. Check here before writing a
> new utility — reuse an existing one if it fits.

_Last updated: 2026-09-03_

This initial catalog covers the topic/SDK helpers touched by this change, not the
entire repository.

| Method | Signature | What it does | File |
| ------ | --------- | ------------ | ---- |
| artifactKeyFor | (originalKey, artifact) => string | Derives a deterministic immutable S3 key for a reconciled question artifact | ingestion-pipeline/scripts/lib/youtube-topic-reconciliation.ts |
| fetchDocumentRecords | (collection, docId) => Promise<RecordSnapshot[]> | Reads and orders complete Chroma question records without invoking embeddings | ingestion-pipeline/scripts/lib/youtube-topic-reconciliation.ts |
| parseQuestionsArtifact | (raw, docId) => YouTubeQuestionsArtifact | Validates the durable YouTube question artifact contract | ingestion-pipeline/scripts/lib/youtube-topic-reconciliation.ts |
| reconcileArtifact | (artifact, approvedTopics) => Reconciliation | Moves newly approved slugs from proposedTopics to canonical topics | ingestion-pipeline/scripts/lib/youtube-topic-reconciliation.ts |
| recordFingerprint | (record, includeTopics?) => string | Hashes Chroma content, vectors, and normalized metadata for concurrency verification | ingestion-pipeline/scripts/lib/youtube-topic-reconciliation.ts |
| recordsNeedingUpdate | (docId, records, original, updated) => RecordSnapshot[] | Validates question/vector identity and returns metadata-only reconciliation updates | ingestion-pipeline/scripts/lib/youtube-topic-reconciliation.ts |
| ingestionAdapter | (connector) => IngestionAdapter | Resolves a connector to its ingestion implementation | ingestion-pipeline/src/adapters/index.ts |
| prepareNotionDocument | (text, pageTitle?) => ChunkingResult | Cleans Notion Markdown and applies shared structural chunking | ingestion-pipeline/src/adapters/notion/chunking.ts |
| parsePublishPayload | (value: unknown) => PublishPayload | Validates a YouTube publication work payload | ingestion-pipeline/src/adapters/youtube/artifacts.ts |
| parseQuestionSegmentArtifact | (value: unknown) => QuestionSegmentArtifact | Validates stored question/vector segment alignment | ingestion-pipeline/src/adapters/youtube/artifacts.ts |
| parseSegmentPayload | (value: unknown) => SegmentPayload | Validates a timed YouTube segment work payload | ingestion-pipeline/src/adapters/youtube/artifacts.ts |
| parseTranscriptArtifact | (value: unknown) => TranscriptArtifact | Validates the complete timed YouTube transcript artifact | ingestion-pipeline/src/adapters/youtube/artifacts.ts |
| extractYouTubeQuestions | (pool, config, videoTitle, chunks) => Promise<ExtractedQuestion[]> | Extracts substantive timed questions and resolves predicted topic candidates | ingestion-pipeline/src/adapters/youtube/questions.ts |
| createOpenRouter | (apiKey?: string) => OpenRouter | Creates an SDK client with the default endpoint, bounded timeout, and no stacked retries | ingestion-pipeline/src/openrouter.ts |
| generateEmbeddings | (client, model, texts) => Promise<number[][]> | Batches embeddings and validates input/vector index alignment | ingestion-pipeline/src/openrouter.ts |
| generateTopicJson | (client, model, system, user, operation?) => Promise<unknown> | Requests structured JSON with three attempts, scoped logs, and source-safe errors | ingestion-pipeline/src/openrouter.ts |
| applySectionTopics | (document, units, results) => PreparedChunk[] | Applies complete section tag sets to every continuation; clears failed sections | web/lib/section-topics.ts |
| buildClassificationUnits | (document) => ClassificationUnit[] | Covers full section content using bounded classification units | web/lib/section-topics.ts |
| parseUnitTopicResults | (raw, batch, approvedSlugs) => Map | Validates unit assignments and resolves formatting variants to approved stored slugs | web/lib/section-topics.ts |
| createTopicResolver | (slugs: Iterable<string>) => resolver | Maps formatting variants to existing slugs without guessing between ambiguous duplicates | web/lib/topic-normalization.ts |
| normalizeTopicSlug | (name: string) => string | Produces lowercase hyphenated slugs and spells out plus/sharp distinctions | web/lib/topic-normalization.ts |
| normalizeTopicToken | (name: string) => string | Produces the Skills-style comparison key while preserving plus and hash | web/lib/topic-normalization.ts |
| parseTopicProposals | (raw: unknown) => TopicInfo[] | Validates and deduplicates proposed topics by normalized spelling | web/lib/topic-normalization.ts |
| buildTopicAssignmentPrompt | (units, topics) => string | Builds the shared assignment payload with complete supplied units | web/lib/topic-prompts.ts |
| buildTopicDiscoveryPrompt | (markdown, topics) => string | Builds the shared discovery payload with the existing bounded document sample | web/lib/topic-prompts.ts |
