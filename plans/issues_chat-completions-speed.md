# `/api/v1/chat/completions` Speed Optimization

## Status

- [x] Real pipeline and dependency sequence mapped
- [x] Chroma persona index verified: 743 episode turns; episode and style searches return hits
- [x] Real non-streaming benchmark captured with Neon, Chroma Cloud, OpenRouter, attached KB, and uploaded résumé
- [x] Faster-model comparison completed
- [x] Main-Chroma reranker path enabled and benchmarked behind `RERANK_ENABLED=1`
- [ ] Production model decision applied
- [ ] Remaining optimizations implemented
- [ ] Final before/after benchmark completed

## Benchmark setup

- Agent: `project-experience-deep-dive`
- Persona: Vasanth (`cmtwyoa1s000004jshzfd5by4`)
- Context: `Harini_Shekar_Senior_Software_Engineer_Resume.pdf` (3,766 markdown characters)
- Knowledge base: `acme-knowledge` (37 indexed documents)
- Persona index: 743 episode turns plus style records
- Model: `openai/gpt-4.1-mini`
- Response mode: `stream: false`
- Raw data: `web/scripts/bench-results.json`
- Re-run: `cd web && bun scripts/chat-completions-bench.ts`

## Exact learner-turn sequence

Every step currently waits for the previous step.

1. **Session auth (Neon)**
   - Hash runtime token and load the active session, compiled config, runtime state, transcript, and cached completion.
   - Needed for authorization and stateful interview behavior.
2. **Idempotency check (local)**
   - Replay the previous result if the message hash is unchanged.
   - Prevents duplicate grading and duplicate probe-budget use.
3. **Knowledge-base lookup (Neon)**
   - Resolve configured KB slugs to IDs.
4. **Knowledge retrieval (OpenRouter embedding + Chroma query)**
   - Embed the transcript plus active objective and retrieve 3 domain-reference chunks.
   - Gives direction, analysis, and content access to attached training material.
5. **Direction LLM**
   - Classifies answer/question/clarification/off-topic/stop, decides `should_grade`, and says how the conversation should continue.
   - Prevents repeat/audio/meta turns from being graded.
6. **Analysis LLM — gradeable turns only**
   - Grades the answer against current evidence keys and returns evidence updates, classification, and unresolved gaps.
   - Drives coverage and the next interview action.
7. **Action selection (local)**
   - Chooses probe, clarify, challenge, transition, or close from analysis plus runtime state.
8. **Persona episode retrieval (embedding + Chroma query)**
   - Retrieves 3 similar past conversation situations.
   - Helps the content stage choose an interview behavior; examples are not current-learner facts.
9. **Content LLM**
   - Decides what to say and the next question without applying persona wording.
10. **Style-gate LLM**
    - Converts the finished draft into a topic-neutral style-search query.
11. **Style retrieval (embedding + Chroma query)**
    - Retrieves 5 wording/rhythm examples for the same conversational function.
12. **Renderer LLM**
    - Rephrases the content draft in the persona's voice while preserving meaning and question count.
13. **Response assembly (local)**
    - Builds the OpenAI JSON response because `stream: false`.
14. **Persistence (Neon)**
    - Saves runtime state, evidence, transcript, revision, and the idempotency replay payload.

### Context placement

- The uploaded résumé is converted to markdown once when the session is activated and stored in `compiledSnapshot`.
- It is not retrieved from Chroma per turn.
- The full résumé is inserted into direction, analysis, and content prompts as verified session facts.
- The attached knowledge base is separate RAG and runs on every learner turn before direction.

## Measured results

### Total wall time

| Turn | Wall time |
|---|---:|
| Opening | 12,527 ms |
| Ownership answer | 19,923 ms |
| Mechanism answer | 18,964 ms |
| Impact answer | 15,139 ms |
| Repeat request | 1,413 ms |

Median gradeable learner turn: **18,964 ms**.

### Per-step timings

| Step | Ownership | Mechanism | Impact | Median |
|---|---:|---:|---:|---:|
| Session auth | 86 ms | 71 ms | 80 ms | 80 ms |
| KB ID lookup | 60 ms | 61 ms | 68 ms | 61 ms |
| Knowledge retrieval | 3,706 ms | 1,340 ms | 1,148 ms | 1,340 ms |
| Direction LLM | 1,532 ms | 1,553 ms | 1,770 ms | 1,553 ms |
| Analysis LLM | 4,230 ms | 3,587 ms | 2,957 ms | 3,587 ms |
| Episode retrieval | 2,082 ms | 1,368 ms | 1,557 ms | 1,557 ms |
| Content LLM | 1,425 ms | 1,396 ms | 1,274 ms | 1,396 ms |
| Style-gate LLM | 1,679 ms | 4,838 ms | 1,610 ms | 1,679 ms |
| Style retrieval | 2,513 ms | 2,168 ms | 1,843 ms | 2,168 ms |
| Renderer LLM | 2,404 ms | 2,316 ms | 2,585 ms | 2,404 ms |
| Persist session | 197 ms | 262 ms | 240 ms | 240 ms |

Across the three gradeable turns:

- LLM calls: **65.1%** of wall time
- Retrieval: **32.8%**
- Database: **2.1%**

### Retrieval breakdown

Knowledge, episode, and style retrieval share the same skeleton:

1. `getOrCreateCollection` against Chroma Cloud
2. Create a query embedding through OpenRouter
3. Run the filtered Chroma query
4. Apply tiny local deduplication/diversification logic

They use different inputs and result counts:

- **Knowledge:** full transcript + objective, `nResults: 3`
- **Episode:** short situation query, `nResults: 9` (`limit: 3 × 3` for source diversification)
- **Style:** style-gate query, `nResults: 15` (`limit: 5 × 3` for source diversification)

Exact learner-turn measurements:

| Retrieval | Turn | Collection | Embedding | Chroma query | Local work | Total |
|---|---|---:|---:|---:|---:|---:|
| Knowledge | Ownership | 809 ms | 2,196 ms | 700 ms | 1 ms | 3,706 ms |
| Knowledge | Mechanism | 347 ms | 701 ms | 292 ms | 0 ms | 1,340 ms |
| Knowledge | Impact | 332 ms | 530 ms | 285 ms | 1 ms | 1,148 ms |
| Episode | Ownership | 587 ms | 969 ms | 526 ms | 0 ms | 2,082 ms |
| Episode | Mechanism | 349 ms | 469 ms | 550 ms | 0 ms | 1,368 ms |
| Episode | Impact | 337 ms | 690 ms | 530 ms | 0 ms | 1,557 ms |
| Style | Ownership | 632 ms | 812 ms | 1,068 ms | 1 ms | 2,513 ms |
| Style | Mechanism | 431 ms | 706 ms | 1,031 ms | 0 ms | 2,168 ms |
| Style | Impact | 336 ms | 700 ms | 806 ms | 1 ms | 1,843 ms |

Why retrieval is slow:

- `getCollection()` calls remote `getOrCreateCollection()` every time; collection handles are not cached. This costs **332–809 ms per retrieval**.
- Every search pays for a separate remote embedding. Warm calls cost **469–812 ms**; the first knowledge embedding took **2,196 ms**.
- Chroma Cloud query time is **285–1,068 ms**. Style is usually slowest because it requests 15 records; episode asks for 9 and knowledge asks for 3.
- Local work is only **0–1 ms**. The delay is network/service time, not JavaScript processing.

The opening primer is different: it does not embed or run similarity search. It scans 743 episode rows in three Chroma pages. It cost **3,568 ms**: collection lookup 946 ms, then pages of 1,907 ms, 411 ms, and 297 ms.

### Models and rate limits

| Job | Model | Response cap |
|---|---|---:|
| Direction | `openai/gpt-4.1-mini` | 1,400 tokens |
| Analysis | `openai/gpt-4.1-mini` | 1,400 tokens |
| Content | `openai/gpt-4.1-mini` | 500 tokens |
| Style gate | `openai/gpt-4.1-mini` | 1,400 tokens |
| Renderer | `openai/gpt-4.1-mini` | 1,400 tokens |
| Knowledge, episode, and style embeddings | `openai/text-embedding-3-small` | n/a |

`cohere/rerank-v3.5` is configured but not used because `RERANK_ENABLED` is off.

There is no fixed TPM value available for these model names through OpenRouter. OpenRouter routes to upstream providers and documents paid-model limits as provider/capacity dependent rather than one account-wide TPM quota. The active key reports a **$100 weekly credit cap** with about **$78.97 remaining**; this is a spending limit, not TPM. The deprecated key `rate_limit` field does not provide a usable TPM limit.

A gradeable turn consumed **13,171–13,946 LLM tokens** in this benchmark. Capacity planning should use that measured demand and production concurrency, while monitoring 429 responses and OpenRouter provider metadata.

### LLM tokens and cost

| Stage | Typical prompt tokens | Typical completion tokens |
|---|---:|---:|
| Direction | ~2,546 | ~77 |
| Analysis | ~3,153 | ~320 |
| Content | ~3,589 | ~36 |
| Style gate | ~294 | ~109 |
| Renderer | ~3,268 | ~201 |

Total OpenRouter LLM cost per gradeable turn: **$0.0062–$0.0066**.

## Model comparison

Same conversation, real services, `stream: false`. Quality is the average of relevance, grounding, interview quality, and naturalness scored 1–5 by an independent `openai/gpt-4.1` judge. It is useful directional evidence, not a production eval set.

| Configuration | Median learner turn | Median LLM time | Median cost/turn | Quality | Notes |
|---|---:|---:|---:|---:|---|
| `gpt-4.1-mini` | 15,558 ms | 9,940 ms | $0.00586 | 4.58 | Best response quality; graded 2/3 turns |
| `gpt-4.1-nano:nitro` | 13,602 ms | 8,675 ms | $0.00146 | 4.25 | 12.6% faster; one renderer fallback; weaker naturalness |
| `gemini-2.5-flash-lite:nitro` | 13,652 ms | 7,532 ms | $0.00176 | 4.42 | 12.3% faster overall and 24.2% faster LLM stages; graded all 3 turns |
| `gpt-4.1-mini` + reranker | 17,751 ms | 10,508 ms | $0.00592 | 4.58 | Slower; output quality unchanged |

Because `gpt-4.1-mini` skipped analysis on the impact turn while both faster models graded all three turns, its wall-time comparison is favorable to the baseline. On the first two turns where all models ran analysis, Gemini Flash Lite averaged **13,054 ms** versus GPT-4.1 Mini's **15,810 ms**: **17.4% faster**.

Current best candidate: **`google/gemini-2.5-flash-lite:nitro`**. It had the fastest LLM stages, no renderer fallback, and only a small measured quality drop. It needs a larger interview eval before production replacement.

## Reranker experiment

Before this work, `RERANK_ENABLED=1` only reranked the legacy fallback collection. The normal main-Chroma path returned early. The main path now expands from 3 to 20 candidates and sends them to `cohere/rerank-v3.5` when the flag is enabled.

| Knowledge step | Without reranker | With reranker |
|---|---:|---:|
| Chroma candidate retrieval, median | 1,445 ms | 1,852 ms |
| Cohere reranker, median | — | 809 ms |
| Total | **1,445 ms** | **2,661 ms** |

The reranker added approximately **1.2 seconds per learner turn**. Median full-turn time increased from **15,558 ms to 17,751 ms**.

Retrieval-quality judge scores:

| Turn | Without reranker | With reranker |
|---|---:|---:|
| Ownership | 2/5 | 1/5 |
| Mechanism | 2/5 | 2/5 |
| Impact | 2/5 | 2/5 |

The attached KB contains placement instructions, résumé formatting, and broad system-design course notes. It does not contain specific facts about this learner's order-processing migration. Reranking changed generic results into other generic results (mostly circuit-breaker and system-design notes), so it could not create relevant evidence. Final-response quality stayed **4.58/5** with or without reranking.

Decision from this small test: **keep reranking off** for this flow. First fix KB-to-agent relevance or add a relevance threshold; then rerun the experiment.

Raw comparisons:

- `web/scripts/bench-results-gpt-4.1-mini.json`
- `web/scripts/bench-results-gpt-4.1-nano-nitro.json`
- `web/scripts/bench-results-gemini-2.5-flash-lite-nitro.json`
- `web/scripts/bench-results-gpt-4.1-mini-rerank.json`
- `web/scripts/bench-quality-judge.json`

## Important observations

1. The pipeline is fully sequential; there is no overlap between independent work.
2. The style path alone (`style gate → style retrieval → renderer`) took **6.0–9.3 seconds** per gradeable turn.
3. Analysis is the slowest normal LLM call: median **3.6 seconds**.
4. `getOrCreateCollection` is repeated for each retrieval and costs roughly **0.3–0.8 seconds** each time.
5. The repeat request avoids all LLM calls but still performs knowledge RAG first, costing **1.1 seconds** unnecessarily.
6. One benchmark opening encountered a transient Chroma connection failure. The runtime correctly spoke the content draft, but the failed style query waited roughly **3.4 seconds** before fallback.
7. One earlier run encountered an OpenRouter connection reset during analysis. The runtime fell back, but this confirms that sequential remote calls also increase failure exposure.

## Retrieval root causes (detailed)

All three retrievals (knowledge, episode, style) share one skeleton and all are slow for the same reasons:

1. **No client or collection-handle caching (332–809 ms per retrieval).**
   Every search calls `MainCollectionService.getCollection()` → `ChromaTenantService.getClient()`, which does a Neon org lookup (`db.organization.findUnique`), constructs a new `CloudClient`, and makes a remote `getOrCreateCollection` HTTP call. Three times per turn, before any actual search.
2. **Separate remote embedding call per search (~470–812 ms warm, 2,196 ms cold).**
   Knowledge, episode, and style each call OpenRouter `text-embedding-3-small` independently — 3 round trips per turn.
3. **Strictly sequential waterfall.**
   Knowledge → direction/analysis → episodes → content → style-gate → style retrieval → renderer. No independent work overlaps.
4. **HNSW `ef_search: 200`.**
   Set at collection creation in `main-collection.ts`. For top-3/top-5 requests this explores far more graph nodes than needed; higher `ef_search` linearly increases query latency.
5. **Over-fetching.**
   Diversification multiplies `nResults` (style asks for 15, episodes 9). Style queries consistently measured the slowest Chroma round trips (806–1,068 ms).
6. **Cold-start primer scan (3.3–4.5 s, opening turn only).**
   `getPersonaPrimerStats` pages through 743 episode rows in 3 sequential Chroma `get` calls to compute regex statistics.
7. **Failure amplification.**
   One transient Chroma connection error added ~3.4 s before the style fallback engaged (sequential dependency chain).

## ChromaDB documentation guidance

From docs.trychroma.com (performance guides, query docs, client reference):

1. **Reuse one `CloudClient` and cached `Collection` instances** — do not reconnect or `getOrCreateCollection` per query. (Primary recommendation.)
2. **Keep HNSW indexes in RAM**; swapping sharply increases latency.
3. **Tune `ef_search` after measuring** — higher improves recall but slows queries; match it to actual top-k.
4. **Batch queries** — `query({ queryEmbeddings: [v1, v2, …] })` handles multiple vectors in one round trip; embedding APIs also accept text arrays.
5. **Precompute / minimize embedding overhead** — embedding latency is often the dominant retrieval cost.
6. **Minimize payload** — only request needed `include` fields and result counts.
7. **Warm infrequently used collections** to avoid cold-start latency.

## Optimization work

Ordered plan, one change at a time, measured against the baseline after each:

1. **Cache Chroma client + collection handles in-process** (per org). Expected: removes ~1.0–1.8 s per warm turn.
2. **Tune HNSW `ef_search`** from 200 toward ~40–60 after measuring recall.

### 2. ef_search / nprobe experiment — TESTED, NO CHANGE

The production collection is **SPANN**, not HNSW: Chroma Cloud silently ignored our `hnsw` creation config, and the real schema reports `spann: { search_nprobe: 64, ef_search: 200, … }`. So the `ef_search` tuning assumption was wrong for this collection; the live query-depth knob is `spann.search_nprobe` (read via `collection.configuration`, adjustable via `collection.modify({ configuration: { spann: { search_nprobe } } })`).

Method (`web/scripts/efsearch-test.ts`): forked the real org collection (fork `main-efsearch-test-3`, deleted after), embedded the 3 real runtime query shapes once, timed 5 trials per query per config with identical vectors, and compared result overlap against the baseline.

| Config | knowledge (3) | episode (9) | style (15) | Recall vs baseline |
|---|---:|---:|---:|---|
| baseline (`search_nprobe=64`) | 546 ms* | 317 ms | 314 ms | — |
| `search_nprobe=32` | 305 ms | 313 ms | 318 ms | episode 7/9, knowledge 0/3 |
| `search_nprobe=16` | 295 ms | 323 ms | 319 ms | episode 3/9 |
| `search_nprobe=8` | 302 ms | 315 ms | 371 ms | episode **0 results**, style 10/15 |
| restored `search_nprobe=64` | 334 ms | 323 ms | 359 ms | 3/3, 9/9, 15/15 |

\* baseline knowledge includes a cold-connection outlier (3,270 ms max); warm queries are ~300 ms everywhere.

Findings:

1. **No latency win.** Query time is a ~300 ms flat floor at every nprobe value — for our collection sizes (743 episodes, small KB) the cost is network/service round trip, not index search depth.
2. **Recall collapses below 64.** nprobe 16 → 3/9 episodes; nprobe 8 → 0 episode results and 10/15 style. The server default 64 is the recall sweet spot for this data.
3. Conclusion: **do not change production.** `search_nprobe=64` stays. The `hnsw` block in `getOrCreateCollection` creation config is dead config for Chroma Cloud (ignored in favor of SPANN); harmless but should not be relied on.
4. The real query-time floor is ~300 ms per Chroma round trip → strengthens the case for the next rung: **fewer round trips (batch queries/embeddings) and parallelizing independent retrievals**, not shallower searches.
3. **Batch/parallelize retrievals and embeddings** where dependencies allow.

### 3a. Episode retrieval parallelization — DONE (structural), wall win pending quiet-network benchmark

Dependency check first: episode retrieval only needs the latest learner text, prior pending question, and session phase — all known at turn start. It does NOT need direction or analysis output. It previously waited for analysis (~4–7 s in) and then blocked content for another ~1.4–2.5 s.

**Context-enrichment quality test** (`web/scripts/test-episode-parallel.ts`, results in `episode-comparison-results.json`): compared the early query (what parallelism requires) against an enriched query that adds `analysis.classification`, `direction.current_topic`, and `action.name` after the LLM stages:

- Hit overlap between early and enriched: 2/3, 2/3, 1/3 across the three learner turns; cosine scores moved by ≤0.05.
- Both variants return plausible behavior examples; episodes feed style/behavior hints to the content stage, not learner facts.
- Enrichment requires waiting for direction + analysis (~3–7 s), which defeats the parallelism.
- Decision: **ship the early query** — it is semantically identical to today's production query (same inputs, same hardcoded learner state), so retrieval quality is unchanged by construction.

**Implementation** (`web/lib/runtime/openai.ts`):

- On each learner turn, the episode search starts immediately as a promise, concurrent with knowledge RAG, direction, and analysis.
- `generateSpeech` accepts `preloadedEpisodes` (promise or array); falls back to inline retrieval when absent (opening/tool turns).

**Reliability regression found and fixed:** the first parallel run produced **10 Chroma connection failures** (4 episode + 3 knowledge + 3 style) versus 0 in every sequential run — Chroma Cloud drops concurrent requests from the same client.

- Fix (`web/lib/main-collection.ts`): a single-lane queue (`runOnChromaLane`) serializes all main-collection reads; pipeline parallelism is preserved because early-started retrieval promises wait their turn and still complete during the LLM stages. Connection errors rebuild handles and retry (2 attempts).
- Result: next two runs went 2 failures → **0 failures**.

**Measured:** in the clean run, episodes finish at ~1.3 s into the turn while content starts at ~7 s — fully hidden, verified all three turns. Wall medians tonight (15.6–15.9 s vs 15.56 s baseline) show no visible win because Chroma Cloud/network latency was elevated all evening (knowledge.search median 2.2–2.5 s vs 1.3–1.4 s at baseline). The structural saving (~1.4 s off the critical path) is real but needs a quiet-network A/B for the headline number.

**Output quality:** judge (`openai/gpt-4.1`) compared baseline vs parallel final responses (`bench-quality-judge-parallel.json`): no regression — the parallel run scored equal or higher on all four dimensions (naturalness 5 vs 4 on all turns; treated as sampling variance, not an improvement claim).

Checks: knowledge + org-knowledge + runtime-check — 26 pass.

3b. **Batch/parallelize embeddings and remaining retrievals** where dependencies allow.
4. Repeat-request short-circuit before knowledge retrieval (~1.1 s waste).

### 1. Client + collection cache — DONE

Implementation (`web/lib/chroma-tenant.ts`, `web/lib/main-collection.ts`):

- `clientCache: Map<orgId, ChromaClient>` — the resolved tenant/database client is built once per org per process; the Neon org lookup and provisioning check only run on first use.
- `collectionCache: Map<orgId, Collection>` — the `getOrCreateCollection` handle is cached per org (Chroma docs recommendation).
- Both are in-process module Maps keyed by `orgId`. On Vercel each warm Lambda/instance keeps its own cache; cold starts pay the setup once, same as today.
- `deleteOrgDatabase` (org Chroma teardown) evicts both via the exported `invalidateCollectionCache()` so a later re-provision can't reuse a stale handle.
- Collection HNSW config only matters at creation, so handle reuse cannot change index settings.

Measured (same 5-turn conversation, `gpt-4.1-mini`, rerun `bench-results-cached-client.json`):

- 13 collection-handle calls in one run: first **1,019 ms**, all subsequent **0 ms** (previously 332–809 ms each).
- Retrieval sub-costs (embedding, query) unchanged as expected — the cache only removes the handle overhead.
- Learner-turn medians: baseline 15,558 ms → 14,991 ms (~4%). Smaller than expected at turn level because embedding/LLM variance (±1–3 s run to run) swamps a ~0.3–0.8 s saving; the saving is structural and compounds with the parallelization work below.
- Checks: `knowledge.test.ts` + `org-knowledge.test.ts` + `runtime-check.test.ts` all pass.
