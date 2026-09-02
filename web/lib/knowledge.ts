// Knowledge ingestion + hybrid retrieval over ChromaDB.
//
// Improvements over Chroma defaults (see digest/ experiments):
// 1. bring-your-own embeddings (OpenAI-compatible API) instead of MiniLM
// 2. client-side hybrid search: vector ANN + BM25 fused with RRF
// 3. HNSW tuned at collection creation: cosine space, higher ef_search
// 4. optional cross-encoder reranking via Cohere when COHERE_API_KEY is set
import { ChromaClient, CloudClient, type Collection, type EmbeddingFunction } from "chromadb";
import { z } from "zod";
import { ChunkingService } from "./chunking-service";
import { createOpenRouter, generateEmbeddings } from "../../ingestion-pipeline/src/openrouter";
import { segmentsFromMarkdown } from "../../shared/youtube/captions";

const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";
const CHROMA_API_KEY = process.env.CHROMA_API_KEY;
const CHROMA_TENANT = process.env.CHROMA_TENANT;
const CHROMA_DATABASE = process.env.CHROMA_DATABASE;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

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
  return generateEmbeddings(createOpenRouter(), EMBEDDING_MODEL, texts);
}

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

async function getCollection(kbSlug: string): Promise<Collection> {
  const client = CHROMA_API_KEY
    ? (() => {
      if (!CHROMA_TENANT || !CHROMA_DATABASE) {
        throw new Error("CHROMA_TENANT and CHROMA_DATABASE are required when CHROMA_API_KEY is set");
      }
      return new CloudClient({ apiKey: CHROMA_API_KEY, tenant: CHROMA_TENANT, database: CHROMA_DATABASE });
    })()
    : new ChromaClient(parseChromaUrl(CHROMA_URL));
  return client.getOrCreateCollection({
    name: `kb_${kbSlug}`,
    // Supplying the same function used for precomputed vectors prevents Chroma
    // from resolving its optional @chroma-core/default-embed package.
    embeddingFunction: openRouterEmbeddings,
    // Cloud uses SPANN; the local HNSW tuning remains unchanged.
    configuration: CHROMA_API_KEY
      ? { spann: { space: "cosine" } }
      : { hnsw: { space: "cosine", ef_construction: 200, ef_search: 200, max_neighbors: 24 } },
 });
}

/** Prepare and tag one document once, then replace its stable Chroma records.
 * Legacy positional topic overrides are rejected because chunk boundaries changed. */
export async function ingestDoc(
  kbSlug: string,
  docId: string,
  source: string,
  markdown: string,
  opts?: { topics?: string[][] },
): Promise<number> {
  if (opts?.topics !== undefined) throw new Error("Legacy positional topic overrides are unsupported for the new chunk layout");
  if (!markdown.trim()) return 0;
  const startedAt = Date.now();
  console.info(`[DB:knowledge-index] start docId=${docId}`);
  try {
    // Load ingestion-only dependencies here; benchmark utility imports stay DB-free.
    const { db } = await import("./db");
    const { classifyPreparedDocument } = await import("./topics");
    const document = await db.knowledgeDocument.findFirst({
      where: { id: docId, kb: { slug: kbSlug } },
      select: { title: true, externalId: true, source: { select: { connector: true } } },
    });
    if (!document) throw new Error("Knowledge document not found in this knowledge base");
    const provider = document.source?.connector ?? "markdown";
    const segments = provider === "youtube" ? segmentsFromMarkdown(markdown) : undefined;
    if (segments && !segments.length) {
      throw new Error("Stored YouTube transcript has no timestamped captions. Reimport the video through its owner's YouTube connection.");
    }
    const prepared = await new ChunkingService().prepare(provider, segments
      ? { segments, pageTitle: document.title }
      : { text: markdown, pageTitle: document.title });
    const chunks = await classifyPreparedDocument(prepared.sourceText, prepared);
    if (!chunks.length) return 0;
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
    const collection = await getCollection(kbSlug);
    await collection.delete({ where: { docId } });
    for (let i = 0; i < chunks.length; i += 250) {
      const batch = chunks.slice(i, i + 250);
      await collection.upsert({
        ids: batch.map((_, j) => `${docId}#${i + j}`),
        embeddings: embeddings.slice(i, i + 250),
        documents: batch.map((chunk) => chunk.text),
        metadatas: batch.map((chunk, j) => ({
          docId, source, chunkIndex: i + j, chunkCount: chunks.length,
          pageTitle: prepared.pageTitle, chunkingVersion: prepared.chunkingVersion,
          ...(chunk.startSeconds !== undefined ? { startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds! } : {}),
          ...(document.source?.connector === "notion" && document.externalId ? { pageId: document.externalId } : {}),
          ...(chunk.sectionIds.length ? { sectionIds: chunk.sectionIds } : {}),
          ...(chunk.topics.length ? { topics: chunk.topics } : {}),
        })),
      });
    }
    console.info(`[DB:knowledge-index] complete docId=${docId} chunks=${chunks.length} elapsedMs=${Date.now() - startedAt}`);
    return chunks.length;
  } catch (error) {
    console.error(`[DB:knowledge-index] failed docId=${docId} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
    throw error;
  }
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

type ChromaWhere = NonNullable<Parameters<Collection["get"]>[0]>["where"];

export const topicFilterSchema = z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
  .transform((topics) => [...new Set(topics)]);

/** Builds an ANY-of metadata filter over chunk topic arrays; undefined when unset. */
function topicWhere(topics?: string[]): ChromaWhere {
  const list = (topics ?? []).map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) return undefined as ChromaWhere;
  if (list.length === 1) return { topics: { $contains: list[0] } };
  return { $or: list.map((t) => ({ topics: { $contains: t } })) };
}

/** Hybrid retrieval: vector top-10 + BM25 top-10 -> RRF -> optional reranker.
 * opts.topicFilter restricts both retrieval arms to chunks carrying any of the topics. */
export async function searchKnowledge(
  kbSlug: string,
  query: string,
  topK = 5,
  opts?: { topicFilter?: z.infer<typeof topicFilterSchema> },
): Promise<Hit[]> {
  if (!Number.isInteger(topK) || topK < 1) throw new Error("topK must be a positive integer");
  const startedAt = Date.now();
  const candidateDepth = Math.max(10, topK) * 3;
  console.info(`[DB:knowledge-search] start candidates=${candidateDepth} filters=${opts?.topicFilter?.length ?? 0}`);
  try {
    const { db } = await import("./db");
    const indexed = await db.knowledgeDocument.findMany({ where: { kb: { slug: kbSlug }, status: "indexed" }, select: { id: true } });
    const indexedDocIds = new Set(indexed.map((document) => document.id));
    if (!indexedDocIds.size) return [];
    const collection = await getCollection(kbSlug);
    const where = topicWhere(opts?.topicFilter);

    const [queryEmbedding] = await embedTexts([query]);
    const vec = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: candidateDepth,
      include: ["documents", "metadatas"],
      ...(where ? { where } : {}),
    });

    // ponytail: BM25 runs over all chunk texts fetched per query — fine for KB-scale
    // corpora (<10k chunks); move to a real lexical index if this grows.
    const all = await collection.get({ include: ["documents", "metadatas"], ...(where ? { where } : {}) });
    const allDocuments = (all.documents ?? []) as string[];
    const allMetadata = (all.metadatas ?? []) as Record<string, unknown>[];
    const activeIndices = all.ids.map((_, index) => index)
      .filter((index) => indexedDocIds.has(String(allMetadata[index]?.docId ?? all.ids[index].split("#")[0])));
    const corpusDocs = activeIndices.map((index) => allDocuments[index] ?? "");
    const corpusIds = activeIndices.map((index) => all.ids[index]);
    const corpusMetadata = activeIndices.map((index) => allMetadata[index]);
    const lex = bm25Scores(query, corpusDocs);
    const lexTop = [...corpusIds.keys()]
      .sort((x, y) => lex[y] - lex[x])
      .filter((i) => lex[i] > 0)
      .slice(0, candidateDepth)
      .map((i) => corpusIds[i]);

    const vecMetadata = (vec.metadatas?.[0] ?? []) as Record<string, unknown>[];
    const vecIds: string[] = (vec.ids[0] ?? []).filter((id, index) => Boolean(id)
      && indexedDocIds.has(String(vecMetadata[index]?.docId ?? id.split("#")[0])));
    const fused = rrf(vecIds, lexTop);
    const textById = new Map<string, string>();
    const docOf = new Map<string, string>();
    const sourceOf = new Map<string, string>();
    for (const [i, id] of corpusIds.entries()) {
      const metadata = corpusMetadata[i];
      textById.set(id, corpusDocs[i] ?? "");
      docOf.set(id, String(metadata?.docId ?? id.split("#")[0]));
      sourceOf.set(id, String(metadata?.source ?? metadata?.docId ?? id.split("#")[0]));
    }
    for (const [i, id] of vecIds.entries()) {
      if (!textById.has(id)) textById.set(id, ((vec.documents?.[0] ?? []) as string[])[i] ?? "");
    }

    const candidates: Hit[] = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, candidateDepth)
      .map(([id, score]) => ({
        id,
        docId: docOf.get(id) ?? id.split("#")[0],
        source: sourceOf.get(id) ?? docOf.get(id) ?? id.split("#")[0],
        text: textById.get(id) ?? "",
        score,
      }));

    const hits = await rerank(query, candidates, topK);
    console.info(`[DB:knowledge-search] complete hits=${hits.length} elapsedMs=${Date.now() - startedAt}`);
    return hits;
  } catch (error) {
    console.error(`[DB:knowledge-search] failed elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
    throw error;
  }
}

// ---- reranking ----------------------------------------------------------

/** Cross-encoder rerank via OpenRouter when configured; otherwise pass through RRF order. */
async function rerank(query: string, hits: Hit[], topK: number): Promise<Hit[]> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY;
  if (!key || hits.length === 0) return hits.slice(0, topK);
  const model = process.env.RERANK_MODEL ?? "cohere/rerank-v3.5";
  const startedAt = Date.now();
  console.info(`[LLM:knowledge-rerank] start model=${model} candidates=${hits.length}`);
  try {
    const body = await createOpenRouter(key).rerank.rerank({
      requestBody: { model, query, documents: hits.map((hit) => hit.text), topN: hits.length },
    }, { timeoutMs: 30_000 });
    if (typeof body === "string") throw new Error("Expected structured rerank results");
    console.info(`[LLM:knowledge-rerank] complete model=${model} elapsedMs=${Date.now() - startedAt}`);
    return body.results.map((r) => ({ ...hits[r.index], score: r.relevanceScore })).slice(0, topK);
  } catch (error) {
    console.warn(`[LLM:knowledge-rerank] fallback=rrf model=${model} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.name : "UnknownError"}`);
    // reranker is an enhancement; fall back to fused ordering on any failure
    return hits.slice(0, topK);
  }
}
