// Step 3: run the benchmark matrix.
//
//   bun run bench [--strategies all] [--arms vector,bm25,hybrid,hybrid-rerank]
//                 [--judged-arm hybrid] [--questions N] [--no-judge]
//                 [--keep-collections] [--index-only] [--dry-run] [--confirm]
//
// Without --confirm the runner prints the plan and exits, so nothing is spent
// until you've reviewed it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromaClient, type Collection } from "chromadb";
import "./env";
import { bm25Scores, embedTexts, rrf } from "../../web/lib/knowledge";
import { selectStrategies } from "./strategies";
import { RELEVANCE_THRESHOLD, mean, scoreRanking, spanCoverage, type RetrievalMetrics } from "./metrics";
import { llmJson, rerank } from "./llm";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../fixtures/page.md");
const fixtureManifestPath = resolve(here, "../fixtures/manifest.json");
const fixturePagesDir = resolve(here, "../fixtures/pages");
const goldenPath = resolve(here, "../golden/questions.json");
const reportsDir = resolve(here, "../reports");

const ARMS = ["vector", "bm25", "hybrid", "hybrid-rerank"] as const;
type Arm = (typeof ARMS)[number];
type Judged = { faithfulness: number; answerRelevance: number; contextPrecision: number };

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

function parseChromaUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 8000), ssl: u.protocol === "https:" };
}

type IndexedChunk = {
  id: string;
  text: string;
  pageId: string;
  pageTitle: string;
  chunkIndex: number;
  chunkCount: number;
};

async function freshCollection(
  client: ChromaClient,
  name: string,
  chunks: IndexedChunk[],
  vectors: number[][],
  sourceUrl: string,
  strategy: string,
): Promise<Collection> {
  try {
    await client.deleteCollection({ name });
  } catch {
    // first run: nothing to delete
  }
  const collection = await client.createCollection({ name, configuration: { hnsw: { space: "cosine", ef_construction: 200, ef_search: 200, max_neighbors: 24 } } });
  await collection.upsert({
    ids: chunks.map((chunk) => chunk.id),
    embeddings: vectors,
    documents: chunks.map((chunk) => chunk.text),
    metadatas: chunks.map((chunk) => ({
      documentId: chunk.pageId,
      pageId: chunk.pageId,
      pageTitle: chunk.pageTitle,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      strategy,
      sourceUrl,
    })),
  });
  const probeIndexes = [...new Set([0, Math.floor(vectors.length / 2), vectors.length - 1])];
  const startedAt = Date.now();
  console.info(`[DB:chroma-index] start collection=${name} probes=${probeIndexes.length}`);
  while (true) {
    const probe = await collection.query({
      queryEmbeddings: probeIndexes.map((i) => vectors[i]),
      nResults: 1,
      include: ["distances"],
    });
    const ready = probeIndexes.every((_, i) => {
      const distance = probe.distances?.[i]?.[0];
      return typeof distance === "number" && distance <= 0.00001;
    });
    if (ready) break;
    if (Date.now() - startedAt > 60_000) throw new Error(`Chroma index readiness timed out for ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.info(`[DB:chroma-index] complete collection=${name} elapsedMs=${Date.now() - startedAt}`);
  return collection;
}

type GoldenFile = {
  createdAt: string;
  model: string;
  items: { id: string; question: string; answer: string; goldSpan: string }[];
};

type FixtureManifest = {
  sourceUrl: string;
  pages: { id: string; title: string }[];
};

function loadFixtureDocuments(manifest: FixtureManifest) {
  return manifest.pages.map((page) => ({
    ...page,
    markdown: readFileSync(join(fixturePagesDir, `${page.id}.md`), "utf8"),
  }));
}

type ArmResult = { ranking: string[]; latencyMs: number };

async function retrieve(
  arm: Arm,
  collection: Collection,
  corpusIds: string[],
  corpusDocs: string[],
  query: string,
  queryEmbedding: number[],
): Promise<ArmResult> {
  const startedAt = Date.now();
  if (arm === "bm25") {
    const lex = bm25Scores(query, corpusDocs);
    const ranking = [...corpusIds.keys()]
      .sort((a, b) => lex[b] - lex[a])
      .filter((i) => lex[i] > 0)
      .slice(0, 10)
      .map((i) => corpusIds[i]);
    return { ranking, latencyMs: Date.now() - startedAt };
  }

  const vec = await collection.query({ queryEmbeddings: [queryEmbedding], nResults: 10, include: ["documents"] });
  const vecIds: string[] = (vec.ids[0] ?? []).filter(Boolean);
  if (arm === "vector") return { ranking: vecIds, latencyMs: Date.now() - startedAt };

  const lex = bm25Scores(query, corpusDocs);
  const lexTop = [...corpusIds.keys()]
    .sort((a, b) => lex[b] - lex[a])
    .filter((i) => lex[i] > 0)
    .slice(0, 10)
    .map((i) => corpusIds[i]);
  const fused = [...rrf(vecIds, lexTop).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (arm === "hybrid") return { ranking: fused.slice(0, 10), latencyMs: Date.now() - startedAt };

  // hybrid-rerank: cross-encoder over the fused candidates
  const textOf = new Map(corpusIds.map((id, i) => [id, corpusDocs[i]]));
  const candidates = fused.slice(0, 10);
  const order = await rerank(query, candidates.map((id) => textOf.get(id) ?? ""), 10);
  return { ranking: order.map((i) => candidates[i]).filter(Boolean), latencyMs: Date.now() - startedAt };
}

async function judgeAnswer(question: string, goldAnswer: string, contexts: string[]): Promise<Judged> {
  const contextBlock = contexts.map((c, i) => `<context index="${i}">\n${c.slice(0, 1200)}\n</context>`).join("\n");
  const gen = (await llmJson(
    'Answer strictly from the provided context. If the context does not contain the answer, use "Not enough information." Respond as JSON: {"answer":"..."}.',
    `${contextBlock}\n\nQuestion: ${question}`,
  )) as { answer?: string };
  const answer = typeof gen.answer === "string" && gen.answer.trim() ? gen.answer.trim() : "(no answer produced)";
  const result = (await llmJson(
    [
      "You grade a RAG pipeline on three axes, each scored 1-5 as an integer:",
      "- faithfulness: every claim in the ANSWER is supported by the CONTEXTS (5 = fully supported, no invented facts).",
      "- answerRelevance: the ANSWER actually addresses the QUESTION (5 = complete direct answer).",
      "- contextPrecision: the CONTEXTS contain what is needed and little irrelevant material (5 = tight, complete).",
      'Respond as JSON: {"faithfulness":n,"answerRelevance":n,"contextPrecision":n}',
    ].join("\n"),
    `<question>${question}</question>\n<gold_answer>${goldAnswer}</gold_answer>\n<contexts>\n${contextBlock}\n</contexts>\n<answer>${answer}</answer>`,
  )) as Partial<Judged>;
  const clamp = (v: unknown) => Math.max(1, Math.min(5, Number(v) || 3));
  return {
    faithfulness: clamp(result.faithfulness),
    answerRelevance: clamp(result.answerRelevance),
    contextPrecision: clamp(result.contextPrecision),
  };
}

type ConfigRow = {
  strategy: string;
  description: string;
  chunks: number;
  avgChunkChars: number;
  arm: Arm;
  metrics: RetrievalMetrics;
  meanLatencyMs: number;
};

async function main() {
  const dryRun = hasFlag("--dry-run");
  const confirmed = hasFlag("--confirm");
  const keepCollections = hasFlag("--keep-collections") || hasFlag("--index-only");
  const indexOnly = hasFlag("--index-only");
  const useJudge = !hasFlag("--no-judge");
  const strategies = selectStrategies(argValue("--strategies"));
  const arms = ((argValue("--arms") ?? "vector,bm25,hybrid,hybrid-rerank").split(",").map((a) => a.trim()) as Arm[]).filter((a) => ARMS.includes(a));
  const judgedArm = (argValue("--judged-arm") ?? "hybrid") as Arm;
  const maxQuestions = Number(argValue("--questions") ?? Number.POSITIVE_INFINITY);

  const markdown = readFileSync(fixturePath, "utf8");
  const manifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8")) as FixtureManifest;
  const documents = loadFixtureDocuments(manifest);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenFile;
  const items = golden.items.slice(0, maxQuestions);

  console.info("=== benchmark plan ===");
  console.info(`fixture: ${markdown.length} chars across ${documents.length} pages | questions: ${items.length}`);
  for (const s of strategies) console.info(`  strategy ${s.name}: ${s.description}`);
  console.info(`arms: ${arms.join(", ")} | judged arm: ${useJudge ? judgedArm : "(none)"}`);
  console.info(`collections: ${keepCollections ? "persist" : "ephemeral"} | mode: ${indexOnly ? "index-only" : "benchmark"}`);
  const llmCalls = indexOnly ? 0 : strategies.length * items.length * (useJudge ? 2 : 0);
  const rerankCalls = indexOnly || !arms.includes("hybrid-rerank") ? 0 : strategies.length * items.length;
  console.info(`estimated API calls: ~${strategies.length} embedding batches, ${rerankCalls} reranks, ${llmCalls} chat completions`);

  if (!confirmed) {
    if (dryRun) console.info("dry-run: stopping before any network calls.");
    else console.info("plan only — re-run with --confirm to execute.");
    return;
  }

  const client = new ChromaClient(parseChromaUrl(process.env.CHROMA_URL ?? "http://localhost:8000"));

  // One query embedding per question, reused across every strategy and arm.
  const queryEmbeddings = new Map<string, number[]>();
  if (!indexOnly) {
    for (const item of items) {
      const [embedding] = await embedTexts([item.question]);
      queryEmbeddings.set(item.id, embedding);
    }
    console.info(`embedded ${items.length} queries`);
  }

  const rows: ConfigRow[] = [];
  const judgedScores = new Map<string, Judged[]>(); // key: `${strategy.name}|${arm}`

  for (const strategy of strategies) {
    const startedAt = Date.now();
    const chunks: IndexedChunk[] = [];
    for (const document of documents) {
      const pageChunks = await strategy.run(document.markdown);
      chunks.push(...pageChunks.map((chunk, chunkIndex) => ({
        id: `${document.id}#${chunkIndex}`,
        text: chunk.text,
        pageId: document.id,
        pageTitle: document.title,
        chunkIndex,
        chunkCount: pageChunks.length,
      })));
    }
    if (chunks.length === 0) throw new Error(`strategy ${strategy.name} produced zero chunks`);
    const vectors = await embedTexts(chunks.map((c) => c.text));
    const collectionName = `bench__${strategy.name.replace(/[^a-z0-9]/gi, "_")}`;
    const collection = await freshCollection(client, collectionName, chunks, vectors, manifest.sourceUrl, strategy.name);
    console.info(`[${strategy.name}] indexed ${chunks.length} chunks (${Date.now() - startedAt}ms incl. embeddings)`);
    if (indexOnly) continue;

    // Corpus snapshot for BM25 + relevance matching.
    const stored = await collection.get({ include: ["documents"] });
    const corpusIds = stored.ids;
    const corpusDocs = (stored.documents ?? []) as string[];

    for (const arm of arms) {
      const perQuestionMetrics: RetrievalMetrics[] = [];
      const latencies: number[] = [];
      for (const item of items) {
        const { ranking, latencyMs } = await retrieve(arm, collection, corpusIds, corpusDocs, item.question, queryEmbeddings.get(item.id)!);
        latencies.push(latencyMs);
        const textById = new Map(corpusIds.map((id, i) => [id, corpusDocs[i] ?? ""]));
        const relevance = ranking.map((id) => spanCoverage(item.goldSpan, textById.get(id) ?? "") >= RELEVANCE_THRESHOLD);
        perQuestionMetrics.push(scoreRanking(relevance));

        if (useJudge && arm === judgedArm) {
          const contexts = ranking.slice(0, 5).map((id) => textById.get(id) ?? "");
          const judged = await judgeAnswer(item.question, item.answer, contexts);
          const key = `${strategy.name}|${arm}`;
          if (!judgedScores.has(key)) judgedScores.set(key, []);
          judgedScores.get(key)!.push(judged);
        }
      }
      rows.push({
        strategy: strategy.name,
        description: strategy.description,
        chunks: chunks.length,
        avgChunkChars: Math.round(mean(chunks.map((c) => c.text.length))),
        arm,
        metrics: {
          hitAt1: mean(perQuestionMetrics.map((m) => m.hitAt1)),
          hitAt3: mean(perQuestionMetrics.map((m) => m.hitAt3)),
          hitAt5: mean(perQuestionMetrics.map((m) => m.hitAt5)),
          hitAt10: mean(perQuestionMetrics.map((m) => m.hitAt10)),
          mrrAt10: mean(perQuestionMetrics.map((m) => m.mrrAt10)),
          ndcgAt10: mean(perQuestionMetrics.map((m) => m.ndcgAt10)),
        },
        meanLatencyMs: Math.round(mean(latencies)),
      });
      const last = rows[rows.length - 1];
      console.info(
        `[${strategy.name}] ${arm}: hit@5=${last.metrics.hitAt5.toFixed(2)} mrr@10=${last.metrics.mrrAt10.toFixed(2)} ndcg@10=${last.metrics.ndcgAt10.toFixed(2)}`,
      );
    }

    if (!keepCollections) {
      await client.deleteCollection({ name: collectionName }).catch(() => {});
    }
  }

  if (indexOnly) {
    console.info(`index-only complete: kept ${strategies.length} collection(s); no report was written`);
    return;
  }

  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(join(reportsDir, `results-${stamp}.json`), JSON.stringify({ rows, judged: Object.fromEntries(judgedScores) }, null, 2), "utf8");

  const lines: string[] = [
    "# Chunking/retrieval benchmark",
    "",
    `- Fixture: fixtures/page.md (${markdown.length} chars)`,
    `- Questions: ${items.length} (golden/questions.json from ${golden.createdAt})`,
    `- Arms: ${arms.join(", ")} | judged arm: ${useJudge ? judgedArm : "(none)"}`,
    `- Relevance rule: word-set coverage >= ${RELEVANCE_THRESHOLD} between retrieved chunk and gold span`,
    "",
    "| strategy | arm | chunks | avg chars | Hit@1 | Hit@5 | MRR@10 | NDCG@10 | latency(ms) |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.strategy} | ${row.arm} | ${row.chunks} | ${row.avgChunkChars} | ${row.metrics.hitAt1.toFixed(2)} | ${row.metrics.hitAt5.toFixed(2)} | ${row.metrics.mrrAt10.toFixed(2)} | ${row.metrics.ndcgAt10.toFixed(2)} | ${row.meanLatencyMs} |`,
    );
  }

  if (judgedScores.size > 0) {
    lines.push("", "## LLM-judged answer quality (1-5)", "", "| config | faithfulness | answerRelevance | contextPrecision |", "|---|---|---|---|");
    for (const [key, scores] of judgedScores) {
      lines.push(
        `| ${key} | ${mean(scores.map((s) => s.faithfulness)).toFixed(2)} | ${mean(scores.map((s) => s.answerRelevance)).toFixed(2)} | ${mean(scores.map((s) => s.contextPrecision)).toFixed(2)} |`,
      );
    }
  }
  writeFileSync(join(reportsDir, `report-${stamp}.md`), lines.join("\n"), "utf8");
  writeFileSync(join(reportsDir, "latest.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  console.info(`\nreports written: reports/report-${stamp}.md (+ latest.md)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
