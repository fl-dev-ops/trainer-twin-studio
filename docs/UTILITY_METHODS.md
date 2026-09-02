# Utility Methods

> Auto-maintained by the `extract-utilities` skill. Check here before writing a
> new utility — reuse an existing one if it fits.

_Last updated: 2026-08-27_

This initial catalog covers the topic/SDK helpers touched by this change, not the
entire repository.

| Method | Signature | What it does | File |
| ------ | --------- | ------------ | ---- |
| createOpenRouter | (apiKey?: string) => OpenRouter | Creates an SDK client with the default endpoint, bounded timeout, and no stacked retries | ingestion-pipeline/src/openrouter.ts |
| generateEmbeddings | (client, model, texts) => Promise<number[][]> | Batches embeddings and validates input/vector index alignment | ingestion-pipeline/src/openrouter.ts |
| generateTopicJson | (client, model, system, user) => Promise<unknown> | Requests JSON through the SDK with three attempts and source-safe errors | ingestion-pipeline/src/openrouter.ts |
| applySectionTopics | (document, units, results) => PreparedChunk[] | Applies complete section tag sets to every continuation; clears failed sections | web/lib/section-topics.ts |
| buildClassificationUnits | (document) => ClassificationUnit[] | Covers full section content using bounded classification units | web/lib/section-topics.ts |
| parseUnitTopicResults | (raw, batch, approvedSlugs) => Map | Validates unit assignments and resolves formatting variants to approved stored slugs | web/lib/section-topics.ts |
| createTopicResolver | (slugs: Iterable<string>) => resolver | Maps formatting variants to existing slugs without guessing between ambiguous duplicates | web/lib/topic-normalization.ts |
| normalizeTopicSlug | (name: string) => string | Produces lowercase hyphenated slugs and spells out plus/sharp distinctions | web/lib/topic-normalization.ts |
| normalizeTopicToken | (name: string) => string | Produces the Skills-style comparison key while preserving plus and hash | web/lib/topic-normalization.ts |
| parseTopicProposals | (raw: unknown) => TopicInfo[] | Validates and deduplicates proposed topics by normalized spelling | web/lib/topic-normalization.ts |
| buildTopicAssignmentPrompt | (units, topics) => string | Builds the shared assignment payload with complete supplied units | web/lib/topic-prompts.ts |
| buildTopicDiscoveryPrompt | (markdown, topics) => string | Builds the shared discovery payload with the existing bounded document sample | web/lib/topic-prompts.ts |
