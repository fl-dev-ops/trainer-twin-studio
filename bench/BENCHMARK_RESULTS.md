# Vasanth Notion chunking and retrieval benchmark

This file records only the results produced by the completed benchmark. No
values below have been recomputed or changed.

## Canonical artifacts

- Generated Markdown report: `reports/report-2026-08-27T04-43-05.md`
- Current report alias: `reports/latest.md`
- Raw result data: `reports/results-2026-08-27T04-43-05.json`
- Frozen questions: `golden/questions.json`
- Frozen public Notion fixture: `fixtures/page.md`
- Fixture manifest: `fixtures/manifest.json`

## Recorded benchmark inputs

- Fixture: `fixtures/page.md` (213528 chars)
- Questions: 20
- Golden dataset timestamp: `2026-08-26T18:32:00.983Z`
- Retrieval arms: vector, bm25, hybrid, hybrid-rerank
- LLM-judged arm: hybrid
- Relevance rule: word-set coverage >= 0.8 between the retrieved chunk and gold span

## Recorded leading retrieval result

These values are copied from the generated report:

| strategy | arm | chunks | avg chars | Hit@1 | Hit@5 | MRR@10 | NDCG@10 | latency(ms) |
|---|---|---|---|---|---|---|---|---|
| structural-2000 | hybrid-rerank | 180 | 1183 | 0.85 | 1.00 | 0.92 | 0.94 | 510 |

Structural-2000 without reranking produced these recorded rows:

| strategy | arm | chunks | avg chars | Hit@1 | Hit@5 | MRR@10 | NDCG@10 | latency(ms) |
|---|---|---|---|---|---|---|---|---|
| structural-2000 | vector | 180 | 1183 | 0.60 | 0.90 | 0.75 | 0.81 | 1 |
| structural-2000 | bm25 | 180 | 1183 | 0.65 | 0.95 | 0.77 | 0.83 | 4 |
| structural-2000 | hybrid | 180 | 1183 | 0.60 | 1.00 | 0.77 | 0.83 | 15 |

## Recorded LLM-judged result for structural-2000

The completed run judged the hybrid arm, not the hybrid-rerank arm.

| config | faithfulness | answerRelevance | contextPrecision |
|---|---|---|---|
| structural-2000|hybrid | 4.50 | 4.55 | 4.50 |

## Interpretation boundary

The complete 32-row matrix and all eight LLM-judged rows remain in the canonical
generated report. This benchmark used 20 synthetic source-grounded questions and
a combined Markdown fixture. It did not establish confidence intervals, preserve
strict Notion page boundaries, or judge answers from the hybrid-rerank arm.
