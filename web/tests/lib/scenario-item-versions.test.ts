import { beforeEach, expect, mock, test } from "bun:test";

// Scenario items are versioned: a search reads exactly the (skill, version) pairs a call pinned, falls back to any kept
// version when none are tagged yet, and the one-time backfill tags old items with their skill's current version.

const real = await import("@/lib/knowledge");
let embedded = 0;
mock.module("@/lib/knowledge", () => ({ ...real, embedTexts: async (texts: string[]) => { embedded += texts.length; return texts.map(() => [1, 0]); } }));
// Loaded under its own specifier: other test files replace "@/lib/main-collection" with fakes for the whole run.
const { MainCollectionService, scenarioScopeWhere } = (await import("../../lib/main-collection.ts?scenario-item-versions")) as typeof import("@/lib/main-collection");

type Meta = Record<string, string | number | boolean>;
let rows: { id: string; document: string; metadata: Meta }[] = [];
let dropUpserts = false;
const queries: Record<string, unknown>[] = [];
const embeddingWrites: number[][][] = [];

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
  upsert: async ({ ids, documents, metadatas, embeddings }: { ids: string[]; documents: string[]; metadatas: Meta[]; embeddings: number[][] }) => {
    embeddingWrites.push(embeddings);
    if (dropUpserts) return;
    ids.forEach((id, i) => {
      rows = rows.filter((row) => row.id !== id);
      rows.push({ id, document: documents[i], metadata: metadatas[i] });
    });
  },
  query: async ({ where, nResults }: { where: Record<string, unknown>; nResults: number }) => {
    queries.push(where);
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
  embedded = 0;
  queries.length = 0;
  embeddingWrites.length = 0;
  dropUpserts = false;
  rows = [line("olga-wait", 19, "v19 line"), line("olga-wait", 20, "v20 line"), line("olga-price", 4, "price v4 line")];
});

test("managed retrieval uses the exact version and committed attempt, never abandoned or newer examples", async () => {
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "committed-1");
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [{ ...managedItem, text: "Abandoned" }], "abandoned-1");
  await MainCollectionService.writeSkillItems("org", "package-2", "hesitation", [{ ...managedItem, text: "New version" }], "committed-2");
  const hits = await MainCollectionService.searchSkillItems("org", [{ skillVersionId: "package-1", indexScope: "committed-1", itemCount: 1 }], "buyer concern", { role: "trainer" });
  expect(hits.map((hit) => hit.text)).toEqual([managedItem.text]);
  expect(JSON.stringify(queries)).toContain("skillIndexScope");
  expect(JSON.stringify(queries)).not.toContain("abandoned-1");
});

test("managed role/step misses can broaden only within the pinned package", async () => {
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "committed-1");
  const scope = [{ skillVersionId: "package-1", indexScope: "committed-1", itemCount: 1 }];
  expect((await MainCollectionService.searchSkillItems("org", scope, "buyer concern", { step: "unknown", role: "trainer" })).map((hit) => hit.text)).toEqual([managedItem.text]);
  expect(await MainCollectionService.searchSkillItems("org", scope, "buyer concern", { role: "client" })).toEqual([]);
  expect(queries.every((query) => JSON.stringify(query).includes("committed-1"))).toBe(true);
});

test.each([0, 2])("refuses skill_package_unavailable when expected count is %i but one row exists", async (itemCount) => {
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "committed-1");
  await expect(MainCollectionService.searchSkillItems("org", [{ skillVersionId: "package-1", indexScope: "committed-1", itemCount }], "buyer concern")).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
  expect(queries).toHaveLength(0);
});

test("a missing pinned index refuses instead of finding legacy or another version", async () => {
  await expect(MainCollectionService.searchSkillItems("org", [{ skillVersionId: "package-1", indexScope: "missing", itemCount: 1 }], "buyer concern")).rejects.toMatchObject({ code: "skill_package_unavailable" });
  expect(queries).toHaveLength(0);
});

test("a verified empty package is not an index failure and needs no embedding request", async () => {
  expect(await MainCollectionService.searchSkillItems("org", [{ skillVersionId: "package-1", indexScope: "empty", itemCount: 0 }], "buyer concern")).toEqual([]);
  expect(embedded).toBe(0);
  expect(queries).toHaveLength(0);
});

const managedItem = {
  id: "example-1", role: "trainer" as const, context: "The buyer hesitates", text: "What is holding you back?",
  metadata: { step: "explore", skillVersionId: "forged-version", skillIndexScope: "forged-scope", orgId: "forged-org" },
};

test("verified imported vectors retain exact values and managed scope without re-embedding", async () => {
  const vectors = [[0.25, -0.75]];
  expect(await MainCollectionService.writeSkillItems("org", "imported-package", "hesitation", [managedItem], "local-original", { embeddings: vectors })).toBe(1);
  expect(embedded).toBe(0);
  expect(embeddingWrites).toEqual([vectors]);
  expect(rows.find((row) => row.metadata.skillVersionId === "imported-package")?.metadata).toMatchObject({
    orgId: "org", skillIndexScope: "local-original", itemId: managedItem.id, itemIndex: 0,
  });
});

test.each([
  [],
  [[]],
  [[Number.NaN, 0]],
  [[Number.POSITIVE_INFINITY, 0]],
  [[1, 0], [0, 1]],
].map((embeddings) => ({ embeddings })))("invalid imported vectors refuse before provider or index writes: %j", async ({ embeddings }) => {
  await expect(MainCollectionService.writeSkillItems("org", "imported-package", "hesitation", [managedItem], "local-original", { embeddings })).rejects.toThrow("Imported embeddings");
  expect(embedded).toBe(0);
  expect(embeddingWrites).toHaveLength(0);
});

test("imported vectors with different dimensions cannot create a partial index", async () => {
  await expect(MainCollectionService.writeSkillItems("org", "imported-package", "hesitation", [managedItem, { ...managedItem, id: "second" }], "local-original", {
    embeddings: [[1, 0], [1]],
  })).rejects.toThrow("Imported embeddings");
  expect(embedded).toBe(0);
  expect(embeddingWrites).toHaveLength(0);
});

test("managed examples have an authoritative org/version scope and survive legacy pruning", async () => {
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "scope-1");
  await MainCollectionService.writeScenarioItems("org", "olga-wait", "hesitation", 21, [managedItem]);
  expect(await MainCollectionService.skillItemCount("org", "package-1", "scope-1")).toBe(1);
  expect(await MainCollectionService.skillItemCount("other-org", "package-1", "scope-1")).toBe(0);
  expect(await MainCollectionService.skillItemCount("org", "forged-version", "scope-1")).toBe(0);
  await MainCollectionService.pruneScenarioItems("org", "olga-wait", 22);
  expect(await MainCollectionService.skillItemCount("org", "package-1", "scope-1")).toBe(1);
  const hits = rows.filter((row) => row.metadata.skillVersionId === "package-1");
  expect(hits).toHaveLength(1);
  expect(hits[0].metadata).toMatchObject({ orgId: "org", role: "trainer", step: "explore" });
});

test("managed indexing is idempotent and verifies a valid zero-item package", async () => {
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "scope-1");
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "scope-1");
  expect(await MainCollectionService.skillItemCount("org", "package-1", "scope-1")).toBe(1);
  expect(await MainCollectionService.writeSkillItems("org", "empty-package", "hesitation", [], "scope-empty")).toBe(0);
});

test("index count verification refuses silent partial upserts", async () => {
  dropUpserts = true;
  await expect(MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "scope-1")).rejects.toThrow("Skill index count mismatch");
});

test("late writes from an expired attempt cannot alter the committed attempt's index", async () => {
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem], "attempt-current");
  await MainCollectionService.writeSkillItems("org", "package-1", "hesitation", [managedItem, managedItem], "attempt-expired");
  expect(await MainCollectionService.skillItemCount("org", "package-1", "attempt-current")).toBe(1);
  expect(await MainCollectionService.skillItemCount("org", "package-1", "attempt-expired")).toBe(2);
  expect(await MainCollectionService.skillItemCount("org", "package-1", "forged-scope")).toBe(0);
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
