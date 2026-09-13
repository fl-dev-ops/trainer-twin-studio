/**
 * ef_search A/B experiment on a FORK of the org's real collection.
 * Does NOT touch the production collection.
 *
 * Usage: bun scripts/efsearch-test.ts
 */
import { db } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";
import { embedTexts } from "@/lib/knowledge";

const ORG_ID = process.env.ORG_ID!;
const FORK_NAME = process.env.FORK_NAME ?? "main-efsearch-test";
const TRIALS = Number(process.env.TRIALS ?? 5);

// The three real runtime query shapes (knowledge / episode / style).
const QUERIES = {
  knowledge: `Learner: I personally designed and led the migration of our order-processing monolith into event-driven services. I owned the architecture, broke the work into milestones, and reviewed the implementation from five engineers.\nActive objective: Establish what the candidate worked on, how it worked, and what they personally owned.`,
  episode: `Session phase: middle\nLearner situation: We used Kafka with an outbox pattern so database writes and emitted events stayed consistent. Consumers were idempotent using the order ID.\nLearner state: vague`,
  style: `acknowledge the learner's answer and ask one focused follow-up question about their personal contribution`,
};

if (!ORG_ID) throw new Error("ORG_ID required");

const collection = await MainCollectionService.getCollection(ORG_ID);
console.log("forking", FORK_NAME, "…");
let fork;
try {
  fork = await collection.fork({ name: FORK_NAME });
  console.log("fork created");
} catch (error) {
  if (String(error).includes("already exists")) {
    fork = await (fork ?? (collection as any).chromaClient).getCollection({ name: FORK_NAME });
    console.log("reusing existing fork", FORK_NAME);
  } else throw error;
}

const queryVectors = Object.fromEntries(
  await Promise.all(
    Object.entries(QUERIES).map(async ([name, text]) => [name, await embedTexts([text])] as const)
  )
) as Record<string, number[][]>;

const retry = async <T,>(fn: () => Promise<T>, attempts = 4): Promise<T> => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts || !String(error).includes("Failed to connect")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * i));
    }
  }
};

const runBench = async (label: string, efSearch: number | null) => {
  const timings: Record<string, number[]> = {};
  const topIds: Record<string, string[]> = {};
  for (const [name, vectors] of Object.entries(queryVectors)) {
    timings[name] = [];
    for (let t = 0; t < TRIALS; t++) {
      const start = performance.now();
      const res = await retry(() => fork.query({
        queryEmbeddings: vectors,
        nResults: name === "knowledge" ? 3 : name === "episode" ? 9 : 15,
        where: { type: name === "style" ? "persona_style_episode" : name === "episode" ? "persona_voice_episode" : "knowledge" },
        include: ["documents", "metadatas", "distances"],
      }));
      timings[name].push(Math.round(performance.now() - start));
      if (t === TRIALS - 1) topIds[name] = (res.ids?.[0] ?? []);
    }
  }
  return { label, efSearch, timings, topIds };
};

const results = [];
results.push(await runBench("ef_search=200 (current)", null));
for (const [nprobe, ef] of [[32, null], [16, null], [8, null], [64, 40]] as const) {
  await fork.modify({ configuration: { spann: { ...(nprobe ? { search_nprobe: nprobe } : {}), ...(ef ? { ef_search: ef } : {}) } } });
  console.log("modified →", nprobe ? `search_nprobe=${nprobe}` : `spann ef_search=${ef}`);
  // warm once after config change
  await retry(() => fork.query({ queryEmbeddings: queryVectors.knowledge, nResults: 3, include: [] }));
  results.push(await runBench(nprobe ? `search_nprobe=${nprobe}` : `spann ef_search=${ef}`, nprobe ?? ef));
}

// Recall comparison vs the baseline (first result)
const baseline = results[0];
for (const r of results.slice(1)) {
  r.recallVs200 = Object.fromEntries(
    Object.keys(baseline.topIds).map((name) => {
      const a = new Set(baseline.topIds[name]);
      const overlap = r.topIds[name].filter((id) => a.has(id)).length;
      return [name, `${overlap}/${r.topIds[name].length}`];
    })
  );
}

const summary = results.map((r) => ({
  config: r.label,
  timings: Object.fromEntries(
    Object.entries(r.timings).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [name, { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] }];
    }),
  ),
  recallVsBaseline: r.recallVs200 ?? "baseline",
}));
console.log(JSON.stringify(summary, null, 2));
await Bun.write(new URL("./efsearch-results.json", import.meta.url), JSON.stringify({ orgId: ORG_ID, fork: FORK_NAME, trials: TRIALS, results }, null, 2));

// cleanup: delete the fork collection
const client = fork as unknown as { chromaClient?: unknown };
console.log("done; fork collection", FORK_NAME, "left in place for inspection — delete manually or rerun with a new FORK_NAME");
