import { beforeEach, expect, mock, test } from "bun:test";

// Scenario items are versioned: a search reads exactly the (skill, version) pairs a call pinned, falls back to any kept
// version when none are tagged yet, and the one-time backfill tags old items with their skill's current version.

const real = await import("@/lib/knowledge");
mock.module("@/lib/knowledge", () => ({ ...real, embedTexts: async (texts: string[]) => texts.map(() => [1, 0]) }));
// Loaded under its own specifier: other test files replace "@/lib/main-collection" with fakes for the whole run.
const { MainCollectionService, scenarioScopeWhere } = (await import("../../lib/main-collection.ts?scenario-item-versions")) as typeof import("@/lib/main-collection");

type Meta = Record<string, string | number | boolean>;
let rows: { id: string; document: string; metadata: Meta }[] = [];

/** Just enough of Chroma's filter language for these searches: $and, $or, $in, $lt and equality. */
function matches(meta: Meta, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "$and") return (value as Record<string, unknown>[]).every((part) => matches(meta, part));
    if (key === "$or") return (value as Record<string, unknown>[]).some((part) => matches(meta, part));
    if (value && typeof value === "object") {
      const op = value as { $in?: unknown[]; $lt?: number };
      if (op.$in) return op.$in.includes(meta[key]);
      if (op.$lt !== undefined) return typeof meta[key] === "number" && (meta[key] as number) < op.$lt;
    }
    return meta[key] === value;
  });
}
const fake = {
  query: async ({ where, nResults }: { where: Record<string, unknown>; nResults: number }) => {
    const hits = rows.filter((row) => matches(row.metadata, where)).slice(0, nResults);
    return { ids: [hits.map((h) => h.id)], documents: [hits.map((h) => h.document)], metadatas: [hits.map((h) => h.metadata)], distances: [hits.map(() => 0.1)] };
  },
  get: async ({ where, limit, offset }: { where: Record<string, unknown>; limit: number; offset: number }) => {
    const hits = rows.filter((row) => matches(row.metadata, where)).slice(offset, offset + limit);
    return { ids: hits.map((h) => h.id), metadatas: hits.map((h) => h.metadata) };
  },
  update: async ({ ids, metadatas }: { ids: string[]; metadatas: Meta[] }) => {
    ids.forEach((id, i) => (rows.find((row) => row.id === id)!.metadata = metadatas[i]));
  },
  delete: async ({ where }: { where: Record<string, unknown> }) => void (rows = rows.filter((row) => !matches(row.metadata, where))),
};
(MainCollectionService as unknown as { getCollection: () => Promise<unknown> }).getCollection = async () => fake;

const line = (slug: string, version: number | undefined, text: string) => ({
  id: `${slug}@${version ?? "legacy"}#${text}`,
  document: text,
  metadata: { type: "scenario_item", agentSlug: slug, role: "trainer", context: "", scenarioId: slug, ...(version === undefined ? {} : { agentVersion: version }) } as Meta,
});

beforeEach(() => {
  rows = [line("olga-wait", 19, "v19 line"), line("olga-wait", 20, "v20 line"), line("olga-price", 4, "price v4 line")];
});

test("a search reads exactly the pinned versions", async () => {
  const texts = async (scope: { slug: string; version: number }[]) =>
    (await MainCollectionService.searchScenarioItems("org", scope, "client wants to wait", { limit: 6 })).map((hit) => hit.text);
  expect(await texts([{ slug: "olga-wait", version: 19 }])).toEqual(["v19 line"]); // a call that started on v19
  expect(await texts([{ slug: "olga-wait", version: 20 }, { slug: "olga-price", version: 4 }])).toEqual(["v20 line", "price v4 line"]);
});

test("nothing at the pinned version (not tagged yet, or pruned): any kept version rather than no examples", async () => {
  rows = [line("olga-wait", undefined, "old untagged line")];
  const hits = await MainCollectionService.searchScenarioItems("org", [{ slug: "olga-wait", version: 20 }], "wait", { limit: 3 });
  expect(hits.map((hit) => hit.text)).toEqual(["old untagged line"]);
});

test("pruning keeps the live and previous versions only", async () => {
  rows.push(line("olga-wait", 18, "v18 line"));
  await MainCollectionService.pruneScenarioItems("org", "olga-wait", 19);
  expect(rows.map((row) => row.document).sort()).toEqual(["price v4 line", "v19 line", "v20 line"]);
});

test("the backfill tags untagged items with their skill's current version, once; unknown skills are left alone", async () => {
  rows = [line("olga-wait", undefined, "a"), line("olga-wait", 20, "b"), line("gone-skill", undefined, "c")];
  const versionOf = new Map([["olga-wait", 21]]);
  expect(await MainCollectionService.tagUnversionedScenarioItems("org", versionOf)).toBe(1);
  expect(rows.map((row) => row.metadata.agentVersion)).toEqual([21, 20, undefined]);
  expect(await MainCollectionService.tagUnversionedScenarioItems("org", versionOf)).toBe(0);
});

test("one pair is a plain $and; several are an $or of pairs", () => {
  expect(scenarioScopeWhere([{ slug: "a", version: 1 }])).toEqual({ $and: [{ agentSlug: "a" }, { agentVersion: 1 }] });
  expect(scenarioScopeWhere([{ slug: "a", version: 1 }, { slug: "b", version: 2 }])).toEqual({
    $or: [{ $and: [{ agentSlug: "a" }, { agentVersion: 1 }] }, { $and: [{ agentSlug: "b" }, { agentVersion: 2 }] }],
  });
});
