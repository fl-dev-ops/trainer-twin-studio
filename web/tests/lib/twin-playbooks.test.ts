import { expect, mock, test } from "bun:test";

const skill = (id: string, text: string) => ({ source: "scenario-ingest", skill: text, scenario: { scenario: id, name: id, steps: [] } });
// Live rows now: "a" was re-ingested (v2), "c" was ingested after the session started, "b" was deleted.
const live = [
  { slug: "acme-a", name: "A", version: 2, data: skill("a", "A v2") },
  { slug: "acme-c", name: "C", version: 1, data: skill("c", "C v1") },
  { slug: "acme-twin", name: "Twin", version: 1, data: { source: "twin" } },
];
const versions = [{ entitySlug: "acme-a", version: 1, data: skill("a", "A v1") }];

mock.module("@/lib/db", () => ({
  db: {
    agent: { findMany: async () => live },
    specVersion: {
      findMany: async ({ where }: { where: { OR: { entitySlug: string; version: number }[] } }) =>
        versions.filter((v) => where.OR.some((o) => o.entitySlug === v.entitySlug && o.version === v.version)),
    },
  },
}));

const { pinTwinSkills, twinPlaybooks } = await import("@/lib/twins");

test("pinning records only skill twins, with their versions", async () => {
  expect(await pinTwinSkills("org", "p")).toEqual([{ slug: "acme-a", version: 2 }, { slug: "acme-c", version: 1 }]);
});

test("a pinned session keeps the skills and versions it started with", async () => {
  const pinned = [{ slug: "acme-a", version: 1 }, { slug: "acme-b", version: 3 }];
  const playbooks = await twinPlaybooks("org", "p", pinned);
  // a: the old SKILL.md from SpecVersion; b: deleted since, dropped; c: added since, not included.
  expect(playbooks.map((p) => [p.slug, p.skill])).toEqual([["acme-a", "A v1"]]);
});

test("without a pin (older sessions) the live skills are used", async () => {
  expect((await twinPlaybooks("org", "p")).map((p) => p.skill)).toEqual(["A v2", "C v1"]);
});
