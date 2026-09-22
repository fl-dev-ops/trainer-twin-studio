import assert from "node:assert/strict";
import test from "node:test";
import { MainCollectionService } from "../../../lib/main-collection";
import {
  filterRelevantKnowledgeHits,
  knowledgeCollectionName,
  MIN_KNOWLEDGE_SCORE,
  searchKnowledge,
  type KnowledgeHit,
} from "../../../lib/knowledge";

const hit = (id: string, score: number): KnowledgeHit => ({
  id,
  docId: `doc-${id}`,
  source: `source-${id}`,
  text: `text-${id}`,
  score,
});

test("knowledge storage uses immutable database IDs", () => {
  assert.equal(knowledgeCollectionName("kb-id-a"), "kb_kb-id-a");
  assert.notEqual(knowledgeCollectionName("kb-id-a"), knowledgeCollectionName("kb-id-b"));
});

test("knowledge relevance threshold removes weak matches", () => {
  const results = filterRelevantKnowledgeHits([
    hit("strong", MIN_KNOWLEDGE_SCORE + 0.1),
    hit("boundary", MIN_KNOWLEDGE_SCORE),
    hit("weak", MIN_KNOWLEDGE_SCORE - 0.01),
  ]);

  assert.deepEqual(results.map((result) => result.id), ["strong", "boundary"]);
  assert.deepEqual(filterRelevantKnowledgeHits([hit("weak", 0.28)]), []);
});

test("reranking expands and reorders main-collection candidates", async () => {
  const originalSearch = MainCollectionService.searchKnowledge;
  const originalFetch = globalThis.fetch;
  const originalEnabled = process.env.RERANK_ENABLED;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestedLimit = 0;

  MainCollectionService.searchKnowledge = (async (_orgId, _query, options) => {
    requestedLimit = options.limit ?? 0;
    return Array.from({ length: 20 }, (_, index) => ({
      id: `hit-${index}`,
      docId: `doc-${index}`,
      kbId: "kb-id",
      source: `source-${index}`,
      text: `text-${index}`,
      score: 1 - index / 100,
    }));
  }) as typeof MainCollectionService.searchKnowledge;
  globalThis.fetch = (async () => Response.json({
    results: [
      { index: 7, relevance_score: 0.99 },
      { index: 3, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.8 },
    ],
  })) as typeof fetch;
  process.env.RERANK_ENABLED = "1";
  process.env.OPENROUTER_API_KEY = "test-key";

  try {
    const hits = await searchKnowledge("kb-id", "query", 3, "org-id");
    assert.equal(requestedLimit, 20);
    assert.deepEqual(hits.map((hit) => hit.id), ["hit-7", "hit-3", "hit-0"]);
  } finally {
    MainCollectionService.searchKnowledge = originalSearch;
    globalThis.fetch = originalFetch;
    process.env.RERANK_ENABLED = originalEnabled;
    process.env.OPENROUTER_API_KEY = originalKey;
  }
});
