# Chunking / retrieval benchmark

Measures how chunking strategy and retrieval arm affect retrieval quality on one
frozen Notion fixture — fully automated, no human labeling.

## Method

1. **Fixture** (`fixtures/page.md` + `fixtures/pages/<page-id>.md`) — the public
   Vasanth cohort page (+ child pages) fetched once through Notion's public web
   endpoint and frozen as Markdown. Strategies chunk each page independently;
   the combined file remains the source for golden-question generation.
2. **Golden dataset** (`golden/questions.json`, committed) — an LLM writes one
   question per evenly-spaced fine-grained passage; that passage is stored as the
   *gold span*. Committed so every future run answers identical questions.
3. **Matrix** — each strategy's chunks are embedded once with the production
   embedding model into an ephemeral Chroma collection, then every question runs
   through each retrieval arm:
   - `vector` — pure ANN top-10
   - `bm25` — lexical BM25 top-10
   - `hybrid` — RRF fusion of both (the production recipe)
   - `hybrid-rerank` — hybrid + cross-encoder rerank
4. **Metrics**
   - *Retrieval (deterministic)*: Hit@1/3/5/10, MRR@10, NDCG@10 against gold spans.
     A retrieved chunk counts as relevant when word-set coverage between it and
     the gold span ≥ 0.8 in either direction. This allows both coarser and finer
     chunks to match, but is only a relevance proxy; see the limitations below.
   - *LLM-judged answer quality* (default on, judged arm = `hybrid`): answer is
     generated from top-5 contexts by gpt-4o-mini, then graded 1–5 on
     faithfulness / answerRelevance / contextPrecision by a judge model that
     doesn't know which config produced what.
   - *Efficiency*: chunk count, average chars/chunk, mean retrieval latency.

## Reading the report columns

Think of retrieval like search results: finding useful content matters, and
finding it near the top matters too. `@K` means considering the first K results.

| Column | Meaning |
|---|---|
| `arm` | Retrieval method: `vector` uses embedding similarity; `bm25` uses keyword matching; `hybrid` combines their rankings with RRF; `hybrid-rerank` additionally reorders candidates with a reranker. |
| `chunks` | Total chunks created from the entire source corpus, not the number returned per question. |
| `avg chars` | Average characters per chunk, not tokens. |
| `Hit@1` | Fraction of questions whose first result is relevant. |
| `Hit@5` | Fraction of questions with at least one relevant result among the first five. |
| `P@10` | **Precision@10**: $\frac{\text{Relevant items in top 10}}{10}$. Measures retrieval accuracy and noise level in the first 10 candidates. |
| `R@50` | **Recall@50**: $\frac{\text{Relevant items in top 50}}{\text{Total relevant items in corpus}}$. Measures completeness across the entire dataset. |
| `MRR@10` | Mean Reciprocal Rank: average of `1 / rank` for the first relevant result within ten results. |
| `NDCG@10` | Normalized Discounted Cumulative Gain: rewards all relevant results in the first ten with logarithmic position discounting. |
The report uses `NDCG@10`, not `NDCG@1`. All four quality metrics above range
from 0 to 1, with higher values better. Reported values are averages across
questions; chunk count and average size are descriptive, not quality scores.

Illustrative example only — these are not measured benchmark results:

```text
Rank:           1    2    3    4    5
Relevant?       no   yes  no   yes  no

Hit@1 = 0
Hit@5 = 1
Reciprocal rank = 1/2
NDCG rewards both relevant results, discounting lower positions.
```

### Scoring limitations

- `goldSpan` is the frozen source passage used to generate the question, not an
  actual retrieved chunk. Different chunkers need not return identical text.
- Our relevance rule compares unique word sets and divides their intersection
  size by the smaller set's size, requiring at least 0.8 overlap. A small fragment
  can pass while omitting the answer. A hit is therefore not proof of answer
  completeness or semantic correctness.
- Our NDCG implementation builds its ideal ordering from the relevant chunks
  found in the returned list, not all relevant chunks in the corpus. It can look
  strong even when other useful chunks were missed; it is not a corpus-wide
  completeness measure.

### LLM-Judged RAG Triad Metrics (1–5)

- **Faithfulness (1–5)**: Evaluates whether every claim in the generated answer is directly supported by the retrieved context chunks (no hallucination).
- **Answer Relevance (1–5)**: Evaluates how directly and completely the generated answer addresses the interview question.
- **Context Precision (1–5)**: Measures the **signal-to-noise ratio** across the **top-5 retrieved chunks** (`ranking.slice(0, 5)`). Evaluates whether the context fed to the agent contains the exact information needed without distracting or irrelevant material. Determined independently by a blind LLM judge.

## Strategies

| name | what it tests |
|---|---|
| `structural-600/1200/2000` | the production chunker at three size knobs |
| `structural-context-2000` | paragraph packing with page title and active topic/subtopic headings retained on continuations, counting headings within the 3333-character cap |
| `header-context-1200` | production packing + nearest heading propagated onto continuation chunks |
| `recursive-char-800` | LangChain-style recursive character splitting |
| `sentence-overlap-800` | sliding sentence window with overlap (boundary-loss test) |
| `chonkie-recursive-512` | Chonkie JS recursive baseline (no SemanticChunker exists in JS yet) |
| `semantic-0.55` | embedding-based semantic merge of adjacent sentences using production embeddings |

## Run

### 1. Live Deployed Evaluation (`src/live/runner.ts`)
Runs deterministic retrieval quality evaluation directly against the deployed Chroma Cloud database (e.g. `kb_engineering`) where real production-ingested Notion chunks (`structural-context-2000-v1`) and YouTube interview question chunks (`youtube-timestamped-1200-1800-v2`) are already indexed. Evaluates retrieval against the verified ground truth in `golden/live-chroma.json`.

```bash
cd bench && bun install

bun run bench:live --dry-run  # check connection to Chroma Cloud and preview questions
bun run bench:live --confirm  # run full IR metrics against deployed Chroma
```

### 2. Offline Local Benchmark (`src/local/runner.ts`)
Chunks local Markdown fixtures (`fixtures/page.md`), spins up ephemeral collections in a local ChromaDB (`http://localhost:8000`), benchmarks against synthetic golden questions, and drops the collections afterwards.

```bash
bun run local:fetch            # freeze fixtures/page.md (public Notion fetch)
bun run local:fetch:authenticated # freeze fixtures via official Notion API token
bun run local:golden           # generate local synthetic golden questions

bun run bench:local --dry-run  # print plan + estimated API calls, spend nothing
bun run bench:local            # plan only
bun run bench:local --confirm  # execute full matrix on local Chroma and write reports/

# Re-index every strategy for visual inspection without changing reports/latest.md
bun run bench:local --index-only --keep-collections --confirm
```

Useful flags: `--questions 5` (cheap pilot), `--strategies structural-1200,semantic-0.55`,
`--arms vector,hybrid`, `--judged-arm hybrid-rerank`, `--no-judge`,
`--keep-collections`, `--index-only`.

Reports land in `reports/live-<timestamp>.md` (live) or `reports/report-<timestamp>.md` (local); `reports/latest.md` always holds the newest comparison table.
## Chroma UI

Start Chroma with `chroma-config.yaml`, then start the UI at
`/Users/mohammedhasan/Github/Forever Learning/chromadb-ui` with `npm run dev`.
Connect to `http://localhost:8000` using tenant `default_tenant` and database
`default_database`. Each record includes `documentId`, `pageId`, `pageTitle`,
`chunkIndex`, and `chunkCount`; filter by `pageId` and sort by `chunkIndex` to
inspect one Notion page's chunk boundaries in order.

To inspect heading retention without replacing the baseline or writing scores:

```bash
bun run bench --strategies structural-context-2000 --index-only --confirm
```

Open `bench__structural_context_2000` in the UI. This strategy packs short sections
together and repeats the active heading ancestry on continuation chunks.
Context uses separate `Page: <page title>` and `Topic: <topic > subtopic>` lines
followed by a blank line and the content. The topic line is omitted before any
topic heading has appeared; original headings within packed content are retained.
Headings inside fenced code are ignored. Oversized code can still be
split; this is contextual heading retention, not a guarantee of semantic or code
block completeness. Historical results do not measure this new strategy.

## Cost notes (original eight-strategy run, 20 questions × 8 strategies × 4 arms)

- ~8 embedding batches for chunks + 20 query embeddings (text-embedding-3-small)
- 160 reranker calls (only if `hybrid-rerank` enabled)
- 320 chat completions for generation+judging (gpt-4o-mini class)
- Collections are deleted by default. Pass `--keep-collections`, or use
  `--index-only`, to preserve them for inspection.
