# Chunking/retrieval benchmark

- Fixture: fixtures/page.md (213528 chars)
- Questions: 20 (golden/questions.json from 2026-08-26T18:32:00.983Z)
- Arms: vector, bm25, hybrid, hybrid-rerank | judged arm: hybrid
- Relevance rule: word-set coverage >= 0.8 between retrieved chunk and gold span

| strategy | arm | chunks | avg chars | Hit@1 | Hit@5 | MRR@10 | NDCG@10 | latency(ms) |
|---|---|---|---|---|---|---|---|---|
| structural-600 | vector | 467 | 455 | 0.60 | 0.85 | 0.70 | 0.74 | 2 |
| structural-600 | bm25 | 467 | 455 | 0.70 | 0.85 | 0.74 | 0.77 | 5 |
| structural-600 | hybrid | 467 | 455 | 0.65 | 0.85 | 0.74 | 0.77 | 17 |
| structural-600 | hybrid-rerank | 467 | 455 | 0.75 | 0.85 | 0.80 | 0.81 | 536 |
| structural-1200 | vector | 275 | 774 | 0.70 | 0.85 | 0.75 | 0.78 | 2 |
| structural-1200 | bm25 | 275 | 774 | 0.55 | 0.85 | 0.65 | 0.70 | 4 |
| structural-1200 | hybrid | 275 | 774 | 0.60 | 0.85 | 0.71 | 0.74 | 16 |
| structural-1200 | hybrid-rerank | 275 | 774 | 0.80 | 0.85 | 0.82 | 0.83 | 518 |
| structural-2000 | vector | 180 | 1183 | 0.60 | 0.90 | 0.75 | 0.81 | 1 |
| structural-2000 | bm25 | 180 | 1183 | 0.65 | 0.95 | 0.77 | 0.83 | 4 |
| structural-2000 | hybrid | 180 | 1183 | 0.60 | 1.00 | 0.77 | 0.83 | 15 |
| structural-2000 | hybrid-rerank | 180 | 1183 | 0.85 | 1.00 | 0.92 | 0.94 | 510 |
| header-context-1200 | vector | 275 | 774 | 0.70 | 0.85 | 0.75 | 0.78 | 2 |
| header-context-1200 | bm25 | 275 | 774 | 0.55 | 0.85 | 0.65 | 0.70 | 5 |
| header-context-1200 | hybrid | 275 | 774 | 0.60 | 0.85 | 0.71 | 0.74 | 16 |
| header-context-1200 | hybrid-rerank | 275 | 774 | 0.80 | 0.85 | 0.82 | 0.83 | 543 |
| recursive-char-800 | vector | 276 | 771 | 0.20 | 0.40 | 0.28 | 0.33 | 1 |
| recursive-char-800 | bm25 | 276 | 771 | 0.05 | 0.35 | 0.17 | 0.25 | 5 |
| recursive-char-800 | hybrid | 276 | 771 | 0.15 | 0.40 | 0.26 | 0.30 | 16 |
| recursive-char-800 | hybrid-rerank | 276 | 771 | 0.25 | 0.45 | 0.33 | 0.38 | 519 |
| sentence-overlap-800 | vector | 282 | 775 | 0.05 | 0.05 | 0.05 | 0.05 | 2 |
| sentence-overlap-800 | bm25 | 282 | 775 | 0.00 | 0.05 | 0.01 | 0.02 | 5 |
| sentence-overlap-800 | hybrid | 282 | 775 | 0.00 | 0.05 | 0.03 | 0.03 | 16 |
| sentence-overlap-800 | hybrid-rerank | 282 | 775 | 0.00 | 0.05 | 0.03 | 0.03 | 534 |
| chonkie-recursive-512 | vector | 616 | 347 | 0.35 | 0.75 | 0.53 | 0.58 | 2 |
| chonkie-recursive-512 | bm25 | 616 | 347 | 0.45 | 0.70 | 0.54 | 0.59 | 5 |
| chonkie-recursive-512 | hybrid | 616 | 347 | 0.40 | 0.75 | 0.54 | 0.60 | 18 |
| chonkie-recursive-512 | hybrid-rerank | 616 | 347 | 0.70 | 0.80 | 0.75 | 0.75 | 505 |
| semantic-0.55 | vector | 1616 | 128 | 0.50 | 0.80 | 0.64 | 0.68 | 3 |
| semantic-0.55 | bm25 | 1616 | 128 | 0.60 | 0.75 | 0.65 | 0.69 | 6 |
| semantic-0.55 | hybrid | 1616 | 128 | 0.50 | 0.85 | 0.65 | 0.66 | 23 |
| semantic-0.55 | hybrid-rerank | 1616 | 128 | 0.60 | 0.85 | 0.71 | 0.73 | 856 |

## LLM-judged answer quality (1-5)

| config | faithfulness | answerRelevance | contextPrecision |
|---|---|---|---|
| structural-600|hybrid | 4.80 | 4.80 | 4.80 |
| structural-1200|hybrid | 4.60 | 4.60 | 4.60 |
| structural-2000|hybrid | 4.50 | 4.55 | 4.50 |
| header-context-1200|hybrid | 4.60 | 4.55 | 4.55 |
| recursive-char-800|hybrid | 2.50 | 2.70 | 2.55 |
| sentence-overlap-800|hybrid | 2.25 | 2.40 | 2.25 |
| chonkie-recursive-512|hybrid | 4.60 | 4.65 | 4.60 |
| semantic-0.55|hybrid | 4.05 | 4.25 | 3.90 |