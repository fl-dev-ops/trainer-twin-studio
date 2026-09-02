// Retrieval metrics. Gold labels are text spans (not chunk IDs) because chunk
// boundaries differ per strategy; a retrieved chunk counts as relevant when it
// covers the gold span (coarser chunks) or is covered by it (finer chunks).

const words = (s: string): Set<string> =>
  new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));

/** 0..1 — fraction of the smaller word set found in the larger one.
 * ~1 means one text nearly contains the other, in either direction. */
export function spanCoverage(goldSpan: string, candidate: string): number {
  const a = words(goldSpan);
  const b = words(candidate);
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let hits = 0;
  for (const w of small) if (large.has(w)) hits++;
  return hits / small.size;
}

export const RELEVANCE_THRESHOLD = 0.8;

export type Ranking = string[]; // chunk ids, best first

export type RetrievalMetrics = {
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  hitAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
};

/** relevance[i] must be precomputed against this question's gold span. */
export function scoreRanking(relevance: boolean[]): RetrievalMetrics {
  const firstRelevantAt = (k: number): boolean => relevance.slice(0, k).some(Boolean);
  const rank = relevance.findIndex(Boolean);
  const mrr = rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0;
  // Binary-gain NDCG with ideal DCG = sum(1/log2(i+2), i < min(k, #relevant)).
  const dcg = relevance.slice(0, 10).reduce((acc, rel, i) => acc + (rel ? 1 / Math.log2(i + 2) : 0), 0);
  const relevantCount = Math.min(relevance.filter(Boolean).length, 10) || 1;
  const idcg = Array.from({ length: relevantCount }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return {
    hitAt1: firstRelevantAt(1) ? 1 : 0,
    hitAt3: firstRelevantAt(3) ? 1 : 0,
    hitAt5: firstRelevantAt(5) ? 1 : 0,
    hitAt10: firstRelevantAt(10) ? 1 : 0,
    mrrAt10: mrr,
    ndcgAt10: dcg / idcg,
  };
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
