# Production structural chunking, inherited tags, and source cleaning

Strict-plan dialogue: one critic round, no blocking objections. See
`CHUNKING_REQUIREMENT.md`, written before implementation, for acceptance behavior.

## Objectives and evidence

Use structural target 2000/max 3333 characters with stable per-page identity,
separate Page/Topic context, consistent taxonomy tags across section continuations,
and hybrid retrieval with reranking. The measured reference is the original
`structural-2000 + hybrid-rerank`, not this enriched variant. Preserve golden and
report artifacts and make no new retrieval-quality claim.

Add a source-cleaning factory with separate Notion and supplied-plain-transcript
YouTube implementations. No YouTube ingestion adapter currently exists.

No deployment, production re-ingestion, migration, new dependency/test file, or
external benchmark/API spend. Preserve OAuth, SQS identifiers, child discovery,
job handling, S3 source storage, app document IDs, and organization boundaries.

## Intended files

New: root requirements and this plan; `web/lib/chunking.ts`,
`web/lib/section-topics.ts`; `ingestion-pipeline/src/cleaners/factory.ts`,
`cleaners/notion.ts`, and `cleaners/youtube.ts`.

Modify: `bench/src/heading-context.ts`; pipeline `src/notion.ts`,
`src/knowledge.ts`, `src/handler.ts`; web `lib/knowledge.ts`, `lib/topics.ts`,
`app/api/knowledge/[kb]/search/route.ts`, `app/api/copilot/studio/route.ts`.

Verification-discovered addition: `bench/tsconfig.json` maps the existing web
`@/*` alias so shared ingestion imports typecheck in the benchmark project.

Report additional files before editing. Leave `web/lib/specs.ts` unchanged because
it exceeds 400 lines. Keep legacy `chunkMarkdown()` behavior for old benchmarks,
golden generation, and existing checks.

## 1. Source-cleaner factory

Contract: `SourceType = "notion" | "youtube"`;
`SourceCleaner.clean(rawText: string): string`;
`createSourceCleaner(source: SourceType): SourceCleaner`.

Use an explicit switch with separate concrete cleaners and rejection of unsupported
runtime values. Extract existing Notion cleanup without behavior changes and
re-export `sanitizeNotionMarkdown` from `notion.ts` for existing callers.
YouTube normalizes CRLF/CR, excess blank lines, and outer whitespace only in
supplied plain transcripts. Preserve words/code/repetitions/timestamp-like text;
do not add fetching, caption parsing, URL handling, or job routing.

Verify existing sanitizer parity, transcript normalization, and unsupported source
rejection. Handler selects the Notion factory branch before title insertion.

## 2. Shared preparation

Use dependency-free types in `web/lib/chunking.ts`:

```ts
type MarkdownSection = { id: string; headingPath: string[]; text: string };
type PreparedChunk = { text: string; sectionIds: string[]; topics: string[] };
type PreparedDocument = {
  pageTitle: string;
  sections: MarkdownSection[];
  chunks: PreparedChunk[];
};
prepareMarkdown(markdown: string, pageTitle?: string): PreparedDocument;
```

Use explicit page title in production and infer initial H1 for benchmark wrapper
compatibility. Section IDs are document-local ordinals per heading occurrence,
not heading hashes. Sections contain direct content, excluding descendants.
Track ownership before packing. Parse headings without requiring blank lines and
ignore heading-like text inside backtick/tilde fences. Preserve preamble ownership.

Keep existing context packing where compatible; flush earlier content before
oversized pieces and before altering its emitted context. Small sections can share
chunks: keep internal headings and all contributing section IDs. Prefix describes
starting context, not later topics. Count labels/separators in the cap and reject
unusable context before external calls. Empty input yields no chunks; header-only
input yields deterministic context without invented tags. Oversized code may split.

Replace benchmark context implementation with a shared-helper wrapper. Verify
determinism, ownership, order, title stability, and cap on frozen pages.

## 3. Shared section tags

Pure helpers in `web/lib/section-topics.ts`:

```ts
type ClassificationUnit = { index: number; sectionId: string; text: string };
buildClassificationUnits(document: PreparedDocument): ClassificationUnit[];
parseUnitTopicResults(raw: unknown, batch: ClassificationUnit[],
  approvedSlugs: Set<string>): Map<number, string[] | null>;
applySectionTopics(document: PreparedDocument, units: ClassificationUnit[],
  results: Map<number, string[] | null>): PreparedChunk[];
```

Cover complete direct content using fixed 6000-character units including context.
Do not omit the middle. Header-only sections need no classification. Validate
indices against the batch; missing/duplicate/malformed/failed results are null.
Normalize/deduplicate approved slugs only; explicit [] is valid. Any failed unit
makes its whole section untagged. Other sections keep their tags. Union section
tags onto chunks with no final four-tag cap. Skip assignment when no approved
taxonomy exists. Keep existing per-unit 0-4 prompt if appropriate.

Retain PostgreSQL/topicJson and Prisma/chatJson as backend adapters. Both classify
against all approved tags rather than document-sampled subsets. Keep proposed-tag
discovery separately best effort so its failure cannot block known-tag assignment.
Verify valid empty results, failures, unions, complete coverage, and no leakage.

## 4. Pipeline integration

`processRecord`: factory cleanup -> `prepareMarkdown(markdown, page.title)` ->
section classification -> index exact prepared chunks. `indexDocument` accepts
chunks rather than Markdown plus a parallel tag array. Embed before replacement.

Keep `${docId}#${chunkIndex}` IDs and metadata docId/source/chunkIndex/chunkCount/
topics; add pageId/pageTitle/sectionIds and chunkingVersion
`structural-context-2000-v1`. Omit empty metadata arrays.

## 5. Web integration

Keep `ingestDoc` signature to avoid editing specs. Lazily load document title,
externalId, and source type using docId plus KB slug; mark externalId as pageId
only for Notion. Lazy DB/topic imports keep benchmark utilities independent of
Prisma initialization. Prepare/classify/store the same objects as Lambda.

Reject supplied unversioned legacy opts.topics before embedding/writes: matching
array lengths do not prove new layout alignment and mixed-section overrides can
contaminate tags. Current callers do not supply them. Use approved-only tagging
and proposed-only discovery, preserving best-effort enrichment.

## 6. Retrieval

Keep BM25, RRF60, model configuration, defaults/max result counts, response shapes.
Use max(10, topK) for vector, lexical, and fused shortlist; rerank full shortlist,
then slice. Preserve RRF fallback and log it distinctly.

HTTP accepts repeated topic parameters; Copilot accepts optional topicFilter in
its existing Zod schema. Validate nonempty canonical slugs and positive integer k.
ANY-of filtering applies to both arms; unknown valid tags never remove filters.
No UI controls, topic inference, approval flow, or Copilot prompt changes.

## 7. Verification and delivery

Add safe entry/completion/failure elapsed-time logs around changed slow paths.
Typecheck web/pipeline; run existing knowledge checks and pipeline smoke, builds,
and touched-web-file lint. Record bench's three existing missing-export errors.

Manually check frozen/in-memory content for mixed, repeated, nested, header-only,
preamble, later-H1, fence, oversized, empty, and long-context cases. Verify section
classification coverage/failure behavior and matching embedding/storage payloads.
Exercise filtered retrieval depths, higher k, rerank success/fallback, old-override
rejection, and both cleaners using in-memory inputs/clients without external spend.

No new test files, report/golden mutations, live collection replacement, or deployment.
Report static/manual results separately from live integration and retrieval quality.

## Trade-offs & open questions

- The enriched variant is not the measured original; fresh quality measurement is required.
- Consistent tags may still be broad or wrong, especially on unheaded sections.
- Full-content bounded classification costs more than truncated chunk samples.
- Oversized code splitting and existing Notion whitespace normalization remain limitations.
- Reject unversioned overrides rather than risk incorrect alignment or tag propagation.
- Approved-only web tagging deliberately excludes proposed tags from assignment.
- One ingestion-only metadata read avoids editing/splitting specs.ts.
- API filter support does not automatically cause callers to send filters.
- YouTube means supplied plain transcript cleanup only; other formats/fetching need a contract.
- Deployment, re-indexing, and paid measurement remain separate authorization steps.
- Shared runtime imports also require the web alias in the benchmark typecheck config.
