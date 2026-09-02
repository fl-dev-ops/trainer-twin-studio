# Production chunking requirements

## Scope and evidence

Implement the structural-2000 family in application ingestion, with the explicitly
requested page/topic context and consistent app taxonomy tags on continuations.
Use the same preparation logic in the Lambda pipeline, web ingestion/re-indexing,
and the context-aware benchmark strategy.

The measured reference is `structural-2000 + hybrid-rerank` in
`bench/reports/report-2026-08-27T04-43-05.md`. That experiment used the combined
fixture and did not evaluate these new context labels, per-page boundaries, or
tag filters. Its scores must not be attributed to this enriched implementation.
No historical report or golden question is to be rewritten.

## Expected chunk behavior

1. Process each Notion page independently. Preserve the application's `docId`
   and the Notion `pageId` as separate identities.
2. Use a 2,000-character structural target and a 3,333-character maximum including
   context labels and separators. These are character counts, not token counts;
   the target is a packing preference, not an exact chunk length.
3. Continuations repeat separate context fields followed by a blank line:

   ```text
   Page: JavaScript Fundamentals
   Topic: Hoisting > Examples

   <continued source content>
   ```

4. Use document metadata for the page title. A later H1 must not rename the page.
   Do not repeat a matching initial page-title heading as a topic. Unheaded
   content has no invented topic heading.
5. Parse real Markdown heading ancestry, ignoring heading-like lines inside
   backtick and tilde fences. Repeated identical headings have distinct section
   identities. Preserve a preamble section before the first topic.
6. Carry section ownership with source blocks before splitting or packing.
   Do not reconstruct it by searching the emitted chunk strings.
7. Preserve substantive source content and its order after source cleaning.
   Flush earlier text before emitting pieces of an oversized paragraph. This
   is chunking, not summarization.
8. Small adjacent sections may share a chunk. Retain their headings in the body
   and their section identities. A chunk's context prefix describes its starting
   context, not a topic encountered later in that chunk.
9. Empty input yields no chunks. Reject context that leaves no usable content
   budget before embedding or replacing any index records.
10. Oversized code can still split. Neither context labels nor structural
    boundaries guarantee that code and its explanation remain together.

## App taxonomy tags and inheritance

1. Display `Topic:` text is not the app's `topics` metadata. App tags are canonical
   approved slugs from the existing `Topic` table.
2. Classify logical sections, not each continuation independently. Classification
   input includes the section's heading context and full direct content, using
   bounded units for large sections without omitting the middle.
3. Resolve one finalized tag set per section, then assign it to every chunk
   containing that section. Chunk 1 and chunk 2 continuing Hoisting therefore
   retain the same Hoisting-section tags.
4. A mixed-section chunk gets the union of its sections' tags. Never copy all
   page tags onto every chunk, copy the previous chunk's tags blindly, or inherit
   tags between separate Notion pages.
5. Do not truncate the final section/chunk union to four tags. A per-classification
   unit limit does not authorize dropping inherited tags afterward.
6. Both web and Lambda use the approved taxonomy as the assignment allow-list.
   This deliberately corrects the web classifier's previous ability to assign
   proposed topics. New suggestions remain proposed, never auto-approved.
7. Proposed-topic discovery is independent best effort. Its failure must not
   prevent classification against already-approved tags.
8. Invalid, missing, or failed classification units resolve their entire affected
   section to an empty tag set. Valid independent sections retain their tags.
   Do not fabricate tags or fail ingestion solely because enrichment failed.
9. Reject unversioned legacy positional tag overrides before embedding or writes.
   Equal array lengths cannot prove compatibility with new chunk boundaries;
   mixed-section overrides could spread tags into unrelated continuations.

## Preparation and storage

1. Prepare chunk text once. Carry text, section identities, and resolved tags
   together through classification, embedding, and storage; indexing must not
   re-chunk the document independently.
2. Retain stable Chroma IDs `${docId}#${chunkIndex}` and existing metadata
   `docId`, `source`, `chunkIndex`, `chunkCount`, and `topics`.
3. Add `pageTitle`, `sectionIds`, `chunkingVersion`, and `pageId` for Notion
   documents. Omit empty array metadata rather than inventing placeholder tags.
4. Keep the existing document-scoped replacement behavior and embed before
   replacement. Do not delete/rebuild a whole knowledge-base collection.
5. Existing stored records do not change merely because code changes. Deployment
   and re-indexing require a separately authorized execution step.

## Retrieval

1. Apply an explicitly supplied app-tag filter to BOTH vector and BM25 candidate
   retrieval. Multiple tags use ANY-of semantics.
2. Preserve the existing embedding/reranker model configuration, BM25 formula,
   and reciprocal rank fusion constant. Use vector 10 + BM25 10, fuse with RRF,
   then rerank 10 candidates for ordinary requests. For larger explicitly
   requested result counts, use `max(10, requestedCount)` candidates.
3. Rerank the full candidate shortlist, then return the caller's requested count.
   Preserve current API default/max result counts and response shapes.
4. Expose repeated `topic` parameters on the knowledge search route and optional
   `topicFilter` on the Copilot search action. Validate canonical nonempty slugs.
   Unknown valid tags must not silently remove the filter.
5. Preserve unfiltered search and the existing RRF fallback when reranking fails;
   log failures explicitly so fallback is not mistaken for successful reranking.

## Source cleaning factory

1. Add a source-cleaner factory with separate Notion and YouTube implementations.
   Unsupported source types must fail explicitly.
2. Route Notion cleaning through the factory before title insertion and chunking.
   Move the existing sanitizer without changing its cleanup behavior; retain its
   old export for existing callers. Its blank-line normalization is not a
   promise of byte-for-byte code preservation.
3. The YouTube cleaner accepts already-acquired plain transcript text. Normalize
   line endings, excess blank lines, and outer whitespace, preserving word order,
   repeated phrases, punctuation, code, and timestamp-like text.
4. There is no current YouTube knowledge-ingestion integration. This change does
   NOT add URL fetching, downloading, transcription, HTML/SRT/VTT parsing,
   caption deduplication, or YouTube job/source routing.

## Boundaries and verification

- Preserve Notion OAuth, identifier-only SQS payloads, child discovery, job leases,
  statuses, organization isolation, and S3 source-storage behavior.
- Leave `web/lib/specs.ts`, migrations, UI controls, Copilot prompts, and unrelated
  dirty work unchanged. Add no dependency or new test file.
- Preserve legacy chunking utilities used by original benchmarks/golden creation.
- Add safe elapsed-time logging on changed slow paths without source text,
  credentials, or secrets.
- Verify typechecks, touched-file lint, builds, existing checks, and manual
  in-memory flows for continuation ownership, tag unions/failures, source cleaning,
  metadata parity, filtered retrieval, and rerank fallback.
- Keep historical benchmark artifacts unchanged. Report source/build verification
  separately from unrun live integration and unmeasured retrieval quality.
