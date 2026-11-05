import { beforeEach, expect, mock, test } from "bun:test";

// "Built from" on a skill (its live version; the main twin: all its skills, merged) and "Used in" on a knowledge base
// document (live versions of skills that aren't archived), from SkillSource rows.

type SourceRow = { agentId: string; version: number; documentId: string; orgId: string; title: string; items: number; agent: { slug: string; name: string; kind: string; version: number; archivedAt: Date | null } };
let rows: SourceRow[] = [];
let kbDocs: { id: string; title: string }[] = [];

mock.module("@/lib/db", () => ({
  db: {
    skillSource: {
      findMany: async ({ where }: { where: { orgId: string; documentId?: string; OR?: { agentId: string; version: number }[]; agent?: { archivedAt: null } } }) =>
        rows.filter((row) =>
          row.orgId === where.orgId &&
          (!where.documentId || row.documentId === where.documentId) &&
          (!where.OR || where.OR.some((pair) => pair.agentId === row.agentId && pair.version === row.version)) &&
          (!where.agent || row.agent.archivedAt === null)),
    },
    knowledgeDocument: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => kbDocs.filter((doc) => where.id.in.includes(doc.id)),
    },
  },
}));
// Its own specifier: other test files replace modules for the whole run.
const { builtFrom, countSources, usedIn } = (await import("../../lib/skill-sources.ts?skill-sources")) as typeof import("@/lib/skill-sources");

const agent = (slug: string, version: number, archivedAt: Date | null = null) => ({ slug, name: slug.toUpperCase(), kind: "TWIN", version, archivedAt });
beforeEach(() => {
  kbDocs = [{ id: "d1", title: "Session 3 · Osama (renamed)" }, { id: "d2", title: "Objection 1-15" }];
  rows = [
    { agentId: "wait", version: 2, documentId: "d1", orgId: "o", title: "Session 3 · Osama", items: 5, agent: agent("wait", 2) },
    { agentId: "wait", version: 1, documentId: "d1", orgId: "o", title: "Session 3 · Osama", items: 9, agent: agent("wait", 2) }, // old version
    { agentId: "wait", version: 2, documentId: "gone", orgId: "o", title: "Deleted video", items: 1, agent: agent("wait", 2) },
    { agentId: "price", version: 4, documentId: "d1", orgId: "o", title: "Session 3 · Osama", items: 3, agent: agent("price", 4) },
    { agentId: "price", version: 4, documentId: "d2", orgId: "o", title: "Objection 1-15", items: 8, agent: agent("price", 4) },
    { agentId: "old", version: 1, documentId: "d1", orgId: "o", title: "Session 3 · Osama", items: 2, agent: agent("old", 1, new Date()) }, // archived
  ];
});

test("counts items per source document", () => {
  expect([...countSources([{ metadata: { source: "a" } }, { metadata: { source: "a" } }, { metadata: { source: "b" } }, { metadata: {} }, null])]).toEqual([["a", 2], ["b", 1]]);
});

test("a skill's live version: current titles, deleted documents marked, most items first", async () => {
  expect(await builtFrom("o", [{ agentId: "wait", version: 2 }])).toEqual([
    { documentId: "d1", title: "Session 3 · Osama (renamed)", items: 5, exists: true },
    { documentId: "gone", title: "Deleted video", items: 1, exists: false },
  ]);
});

test("the main twin: its skills merged by document", async () => {
  expect(await builtFrom("o", [{ agentId: "wait", version: 2 }, { agentId: "price", version: 4 }])).toEqual([
    // Equal items: by title.
    { documentId: "d2", title: "Objection 1-15", items: 8, exists: true },
    { documentId: "d1", title: "Session 3 · Osama (renamed)", items: 8, exists: true },
    { documentId: "gone", title: "Deleted video", items: 1, exists: false },
  ]);
  expect(await builtFrom("o", [{ agentId: "nothing", version: 1 }])).toBeNull(); // not recorded
});

test("used in: live versions only, archived skills left out", async () => {
  expect(await usedIn("o", "d1")).toEqual([
    { slug: "wait", name: "WAIT", kind: "twin", version: 2, items: 5 },
    { slug: "price", name: "PRICE", kind: "twin", version: 4, items: 3 },
  ]);
});
