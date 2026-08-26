// Self-check for the pure logic in lib/knowledge.ts (no chroma/embeddings needed).
// Run: npx tsx scripts/knowledge-check.ts
import { chunkMarkdown, bm25Scores, rrf } from "../lib/knowledge";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`ok: ${msg}`);
}

// --- chunkMarkdown ---

const doc = `# Title

Intro paragraph with enough text to matter.

## Section one

Para A.

Para B.

### Subsection

Para C is long. ${"word ".repeat(300)}

## Section two

Para D.`;

const chunks = chunkMarkdown(doc);
assert(chunks.every((c) => c.length <= 2100), "size cap respected");
assert(
  ["Para A.", "Para B.", "Para D."].every((p) => chunks.some((c) => c.includes(p))),
  "no content lost"
);
assert(chunks[0].startsWith("# Title"), "first chunk starts at document heading");
// tiny sections pack together by design; with a small target, headings must split
const fine = chunkMarkdown(doc, 100, 400);
assert(fine.length >= 3, `headings start new chunks at low target (${fine.length} chunks)`);
assert(fine.some((c) => c.startsWith("## Section two")), "later sections kept intact");
assert(
  fine.find((c) => c.includes("Para A"))?.includes("Section one") ?? false,
  "paragraphs stay with their section heading"
);

// oversized single paragraph gets sentence-split
const huge = `P ${"sentence here. ".repeat(400)}`;
const big = chunkMarkdown(huge, 1000, 1500);
assert(big.length > 1 && big.every((c) => c.length <= 1600), "oversized paragraph hard-split");

// empty-ish input
assert(chunkMarkdown("").length === 0, "empty input -> no chunks");

// --- bm25 + rrf ---
const corpus = [
  "React re-renders components when state changes",
  "The microtask queue drains before macrotasks like timers",
  "API gateway caching needs cache keys and TTL invalidation",
];
const scores = bm25Scores("microtask queue timers", corpus);
assert(scores[1] > scores[0] && scores[1] > scores[2], "BM25 ranks the matching doc first");
assert(bm25Scores("quantum entanglement", corpus).every((s) => s === 0), "no-match query scores zero");

const fused = rrf(["a", "b", "c"], ["b", "d"]);
assert(fused.get("b")! > fused.get("a")! && fused.get("b")! > fused.get("c")!, "RRF boosts items hit by both lists");

console.log(`\n${passed} checks passed`);
