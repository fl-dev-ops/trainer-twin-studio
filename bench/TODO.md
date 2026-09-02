# Chunking and retrieval benchmark TODO

## Goal

Build a frozen, source-grounded benchmark that first compares chunking strategies
with retrieval held constant, then compares retrieval strategies on the strongest
chunking candidates.

More questions are not automatically better. The golden dataset must maximize
curriculum coverage, question diversity, and reliable evidence labels. Start with
100-200 validated questions rather than generating an unbounded dataset.

## Blockers before the first run

- [ ] Restore or replace the missing Notion fetch functions imported by
  `src/notion-fetch.ts`. The current `web/lib/notion.ts` exports only
  `parseNotionPageId`, so the fetch entrypoint cannot compile.
- [ ] Share the root page and every required child page with the Notion
  integration represented by `NOTION_API_TOKEN`.
- [ ] Start ChromaDB and verify that `CHROMA_URL` is reachable.
- [ ] Confirm the embedding, reranker, generator, and judge model identifiers.
- [ ] Set a run budget before enabling `--confirm`.

## Environment setup

The benchmark reads `web/.env` without overriding variables already exported in
the shell.

Required:

```dotenv
NOTION_API_TOKEN=
OPENROUTER_API_KEY=
CHROMA_URL=http://localhost:8000
```

`LLM_API_KEY` can replace `OPENROUTER_API_KEY` if it points to the configured
OpenRouter-compatible endpoint.

Optional defaults to review and freeze in every report:

```dotenv
BENCH_NOTION_URL=https://app.notion.com/p/CareerwithVasanth-Frontend-development-mastery-cohort-1-2f21199ccfe38090a0b5daf57d7d917c
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=openai/text-embedding-3-small
RERANK_MODEL=cohere/rerank-v3.5
JUDGE_MODEL=openai/gpt-4o-mini
```

Do not commit `web/.env`, tokens, or credentials.

## Freeze the source corpus

- [ ] Fetch the root and all accessible child pages once.
- [ ] Preserve each Notion page as a separate document. Do not concatenate page
  boundaries if production indexes pages separately.
- [ ] Store a manifest containing page ID, title, parent ID, source URL, character
  count, last-edited timestamp, and content hash.
- [ ] Record inaccessible or empty pages instead of silently treating the fetched
  subset as the complete curriculum.
- [ ] Commit the sanitized fixture and manifest only if their contents are safe to
  keep in the repository.
- [ ] Never regenerate the fixture in the middle of a comparison run.

## Prepare the golden dataset

### Required record shape

Each question should contain:

```text
id
question
expectedAnswer
evidenceSpans[]: pageId + exact source text or stable offsets/hash
answerable: true | false
questionType
difficulty
topic/week/session tags
generator model + prompt version
```

Allow multiple evidence spans. A single `goldSpan` cannot correctly represent
questions whose answer requires multiple sections or pages.

### Coverage quotas

- [ ] Cover every substantial page, week/session, heading, and curriculum topic.
- [ ] Include direct factual questions.
- [ ] Include conceptual “why/how” questions.
- [ ] Include procedural and ordered-step questions.
- [ ] Include list and comparison questions.
- [ ] Include paraphrased questions with little lexical overlap.
- [ ] Include questions whose evidence crosses a chunk boundary.
- [ ] Include multi-section and multi-page questions.
- [ ] Include unanswerable/out-of-scope questions to measure false retrieval and
  abstention quality.
- [ ] Deduplicate near-identical questions and repeated source passages.

### Automatic validation

- [ ] Verify that every expected answer is entailed by its evidence spans.
- [ ] Verify that answerable questions cannot be answered from unrelated passages.
- [ ] Reject vague, pronoun-dependent, malformed, duplicate, or trivial questions.
- [ ] Use a different model family for validation/judging than for question
  generation where possible.
- [ ] Freeze the accepted questions before testing any strategy.
- [ ] Store rejection counts and reasons so generation quality is measurable.

Fully automated validation is still a proxy, not ground truth. Before making a
production decision, manually spot-check a small fixed sample once; future
regression runs can then remain automated.

## Benchmark sequence

### Phase A: choose chunking

Hold the embedding model, Chroma settings, retrieval algorithm, top-K, reranker,
and golden questions constant. Compare only chunk boundaries, context propagation,
overlap, and chunk size.

- [ ] Run a cheap pilot on 10-20 questions.
- [ ] Run the full frozen golden dataset only after the pilot is valid.
- [ ] Select the top two or three chunkers using quality and cost together.

### Phase B: choose retrieval

Using only the selected chunkers, compare vector, BM25, hybrid RRF, candidate-pool
sizes, metadata filters, and reranking. The benchmark path must use the same
top-50 fusion and rerank candidate count as production before calling an arm
“production”.

### Phase C: verify answer quality

Generate answers from the exact retrieved context and measure correctness,
faithfulness, completeness, and abstention. Keep generation settings identical
across configurations.

## Metrics to report

Primary retrieval metrics:

- Recall/Hit@1, @3, @5, and @10.
- MRR@10 for the rank of the first relevant result.
- NDCG@10 using relevance labels for the entire candidate corpus, not only the
  retrieved results.
- Context recall and context precision against all evidence spans.

Answer metrics:

- Answer correctness against `expectedAnswer`.
- Faithfulness to retrieved context.
- Completeness across all required evidence spans.
- Abstention accuracy on unanswerable questions.

Operational metrics:

- Indexing time and chunk-time embedding cost.
- Chunk count, duplicate-text ratio, and average/p50/p95 chunk tokens.
- Retrieval latency p50/p95, not only mean latency.
- Retrieved context tokens, API calls, reranker calls, and estimated cost/query.

Reliability:

- Report per-question results and scores by topic/question type.
- Use paired per-question comparisons between configurations.
- Add bootstrap confidence intervals; do not rank strategies from averages alone.
- Repeat LLM-judged runs when scores are close enough to be explained by judge
  variance.

## Questions the completed benchmark must answer

- Which chunking strategy gives the best Recall@5 and MRR@10 on the same queries?
- Does heading propagation improve retrieval for continuation chunks?
- Does sentence overlap fix boundary questions enough to justify duplicated text?
- Which chunk size gives the best quality/context-token tradeoff?
- Does semantic chunking improve paraphrased and conceptual questions specifically?
- Does BM25 add value over vector retrieval, and for which question types?
- How much does hybrid RRF improve over its strongest individual retriever?
- How much incremental quality does reranking add, at what latency and cost?
- Which pages, topics, and question types consistently fail retrieval?
- Do better retrieval metrics actually produce more correct and faithful answers?
- Does the winning configuration answer multi-section questions and correctly
  abstain on out-of-scope questions?
- Is the quality difference statistically meaningful or within benchmark noise?

## Run checklist

```bash
cd bench
bun install
bun run tsc --noEmit
bun run fetch
bun run golden --count 20
bun run bench --dry-run
bun run bench --questions 10 --no-judge --confirm
```

After validating the pilot, generate the full balanced golden dataset and run the
approved matrix. Do not regenerate the golden dataset between configurations.

## Acceptance gates

- [ ] Fixture completeness is recorded and content hashes are frozen.
- [ ] Golden coverage quotas and automatic validation pass.
- [ ] Benchmark retrieval matches the intended production candidate pipeline.
- [ ] Reports include model/config versions, per-slice results, costs, and
  confidence intervals.
- [ ] No production strategy is selected solely from an LLM judge average.
