// Knowledge ingestion + hybrid retrieval over ChromaDB.
//
// Improvements over Chroma defaults (see digest/ experiments):
// 1. bring-your-own embeddings (OpenAI-compatible API) instead of MiniLM
// 2. client-side hybrid search: vector ANN + BM25 fused with RRF
// 3. HNSW tuned at collection creation: cosine space, higher ef_search
// 4. optional cross-encoder reranking via Cohere when COHERE_API_KEY is set
import { ChromaClient, CloudClient, type Collection, type EmbeddingFunction } from "chromadb";

const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";
const CHROMA_API_KEY = process.env.CHROMA_API_KEY ?? "";
const CHROMA_TENANT = process.env.CHROMA_TENANT ?? "";
const CHROMA_DATABASE = process.env.CHROMA_DATABASE ?? "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
// OpenRouter serves embeddings and reranking alongside LLMs
const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

// ---- chunking -----------------------------------------------------------

/** Split markdown into retrieval chunks: heading boundaries respected,
 * paragraphs packed up to targetChars, oversized paragraphs sentence-split. */
export function chunkMarkdown(text: string, targetChars = 1200, maxChars = 2000): string[] {
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (let p of paras) {
    // hard-split paragraphs that alone exceed the cap
    while (p.length > maxChars) {
      const cut = p.lastIndexOf(". ", maxChars);
      const at = cut > maxChars / 2 ? cut + 1 : maxChars;
      chunks.push(p.slice(0, at).trim());
      p = p.slice(at).trim();
    }
    const isHeading = /^#{1,6} /.test(p);
    if (cur && ((isHeading && cur.length >= targetChars * 0.5) || cur.length + p.length > maxChars)) {
      push();
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return chunks;
}

// ---- embeddings ---------------------------------------------------------

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const res = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Embedding API returned ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    // API returns batches sorted by index; be defensive anyway
    out.push(...[...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

// ---- chroma -------------------------------------------------------------

const openRouterEmbeddings: EmbeddingFunction = {
  generate: embedTexts,
  generateForQueries: embedTexts,
  defaultSpace: () => "cosine",
  supportedSpaces: () => ["cosine"],
};

function parseChromaUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 8000), ssl: u.protocol === "https:" };
}

function chromaClient(): ChromaClient {
  // Explicit CHROMA_URL wins (local/self-hosted). Otherwise cloud when configured.
  if (process.env.CHROMA_URL) return new ChromaClient(parseChromaUrl(CHROMA_URL));
  if (CHROMA_API_KEY && CHROMA_TENANT && CHROMA_DATABASE) {
    return new CloudClient({ apiKey: CHROMA_API_KEY, tenant: CHROMA_TENANT, database: CHROMA_DATABASE });
  }
  return new ChromaClient(parseChromaUrl(CHROMA_URL));
}

async function getCollection(kbSlug: string): Promise<Collection> {
  const client = chromaClient();
  return client.getOrCreateCollection({
    name: `kb_${kbSlug}`,
    // Supplying the same function used for precomputed vectors prevents Chroma
    // from resolving its optional @chroma-core/default-embed package.
    embeddingFunction: openRouterEmbeddings,
    // tuned HNSW: cosine fits text embeddings; higher ef_search trades latency for recall
    configuration: { hnsw: { space: "cosine", ef_construction: 200, ef_search: 200, max_neighbors: 24 } },
  });
}

/** Replace all chunks of one doc. Idempotent per docId. */
export async function ingestDoc(
  kbSlug: string,
  docId: string,
  source: string,
  markdown: string,
): Promise<number> {
  const chunks = chunkMarkdown(markdown);
  if (chunks.length === 0) return 0;
  const embeddings = await embedTexts(chunks);
  const collection = await getCollection(kbSlug);
  await collection.delete({ where: { docId } });
  for (let i = 0; i < chunks.length; i += 5000) {
    const batch = chunks.slice(i, i + 5000);
    await collection.upsert({
      ids: batch.map((_, j) => `${docId}#${i + j}`),
      embeddings: embeddings.slice(i, i + 5000),
      documents: batch,
      metadatas: batch.map(() => ({ docId, source })),
    });
  }
  return chunks.length;
}

export async function removeDoc(kbSlug: string, docId: string): Promise<void> {
  try {
    const collection = await getCollection(kbSlug);
    await collection.delete({ where: { docId } });
  } catch {
    // collection may not exist yet; deletion proceeds regardless
  }
}

// ---- hybrid search ------------------------------------------------------

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2) ?? [];

/** BM25 (k1=1.5, b=0.75) of query terms over docs. */
export function bm25Scores(query: string, docs: string[]): number[] {
  const k1 = 1.5, b = 0.75;
  const terms = tokenize(query);
  const docTokens = docs.map(tokenize);
  const n = docs.length;
  const avgdl = docTokens.reduce((a, d) => a + d.length, 0) / (n || 1) || 1;
  const df = new Map<string, number>();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  return docTokens.map((toks, i) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of new Set(terms)) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgdl));
    }
    return s;
  });
}

/** Reciprocal Rank Fusion of two ranked id lists. */
export function rrf(a: string[], b: string[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [list, weight] of [[a, 1], [b, 1]] as const) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1)));
  }
  return scores;
}

type Hit = { id: string; docId: string; source: string; text: string; score: number };

/** Hybrid retrieval: vector top-50 + BM25 top-50 -> RRF -> optional reranker. */
export async function searchKnowledge(kbSlug: string, query: string, topK = 5): Promise<Hit[]> {
  const collection = await getCollection(kbSlug);

  const [queryEmbedding] = await embedTexts([query]);
  const vec = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: 50,
    include: ["documents", "metadatas"],
  });

  // ponytail: BM25 runs over all chunk texts fetched per query — fine for KB-scale
  // corpora (<10k chunks); move to a real lexical index if this grows.
  const all = await collection.get({ include: ["documents", "metadatas"] });
  const corpusDocs = (all.documents ?? []) as string[];
  const corpusIds = all.ids;
  const lex = bm25Scores(query, corpusDocs);
  const lexTop = [...corpusIds.keys()]
    .sort((x, y) => lex[y] - lex[x])
    .filter((i) => lex[i] > 0)
    .slice(0, 50)
    .map((i) => corpusIds[i]);

  const vecIds: string[] = (vec.ids[0] ?? []).filter(Boolean);
  const fused = rrf(vecIds, lexTop);
  const textById = new Map<string, string>();
  const docOf = new Map<string, string>();
  const sourceOf = new Map<string, string>();
  for (const [i, id] of corpusIds.entries()) {
    const metadata = (all.metadatas as Record<string, unknown>[] | undefined)?.[i];
    textById.set(id, corpusDocs[i] ?? "");
    docOf.set(id, String(metadata?.docId ?? id.split("#")[0]));
    sourceOf.set(id, String(metadata?.source ?? metadata?.docId ?? id.split("#")[0]));
  }
  for (const [i, id] of vecIds.entries()) {
    if (!textById.has(id)) textById.set(id, ((vec.documents?.[0] ?? []) as string[])[i] ?? "");
  }

  const candidates: Hit[] = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(topK * 4, 20))
    .map(([id, score]) => ({
      id,
      docId: docOf.get(id) ?? id.split("#")[0],
      source: sourceOf.get(id) ?? docOf.get(id) ?? id.split("#")[0],
      text: textById.get(id) ?? "",
      score,
    }));

  return rerank(query, candidates, topK);
}

// ---- reranking ----------------------------------------------------------

/** Cross-encoder rerank via OpenRouter when configured; otherwise pass through RRF order. */
async function rerank(query: string, hits: Hit[], topK: number): Promise<Hit[]> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key || hits.length === 0) return hits.slice(0, topK);
  const model = process.env.RERANK_MODEL ?? "cohere/rerank-v3.5";
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, query, documents: hits.map((h) => h.text), top_n: topK }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`rerank returned ${res.status}`);
    const body = (await res.json()) as { results: { index: number; relevance_score: number }[] };
    return body.results.map((r) => ({ ...hits[r.index], score: r.relevance_score }));
  } catch {
    // reranker is an enhancement; fall back to fused ordering on any failure
    return hits.slice(0, topK);
  }
}
