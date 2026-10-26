import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const log: string[] = [];
let agents: Row[] = [];
let domains: Row[] = [];
let specVersions: Row[] = [];
let storedItems: { orgId: string; agentSlug: string; count: number } | null = null;

const fakeDb = {
  organization: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      ({ org1: { id: "org1", slug: "acme" }, org2: { id: "org2", slug: "other" } })[where.id] ?? null,
  },
  persona: {
    findFirst: async ({ where }: { where: { orgId: string; slug: string } }) =>
      where.orgId === "org1" && where.slug === "Vasanth" ? { id: "p1" } : null,
  },
  agent: {
    findUnique: async ({ where }: { where: { slug: string } }) => agents.find((a) => a.slug === where.slug) ?? null,
    create: async ({ data }: { data: Row }) => {
      log.push("agent.create");
      agents.push({ id: `a${agents.length + 1}`, ...data });
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      log.push("agent.update");
      Object.assign(agents.find((a) => a.id === where.id)!, data);
    },
  },
  domain: {
    findUnique: async ({ where }: { where: { slug: string } }) => domains.find((d) => d.slug === where.slug) ?? null,
    create: async ({ data }: { data: Row }) => {
      domains.push(data);
    },
  },
  specVersion: { create: async ({ data }: { data: Row }) => void specVersions.push(data) },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};
mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/main-collection", () => ({
  invalidateCollectionCache: () => {},
  invalidatePersonaStyleCache: () => {},
  MainCollectionService: {
    replaceScenarioItems: async (orgId: string, agentSlug: string, _scenarioId: string, items: unknown[]) => {
      log.push("chroma");
      storedItems = { orgId, agentSlug, count: items.length };
      return items.length;
    },
  },
}));

const { buildScenario, ingestScenario, scenarioIngestSchema, skillBody, stepGoal } = await import("@/lib/scenario-ingest");
const { POST } = await import("@/app/api/internal/scenarios/route");

// The shape scenario-ingest's save_skill writes: YAML name/description header + Markdown body.
const SKILL = `---
name: fundamental-depth
description: "Run a progressive technical mock interview."
---
# Progressive Fundamental Depth Drilling

## Goal
- **Interviewer:** Discover how deep the candidate's understanding goes.

## Steps
### 1. Warm-up \`warm-up\`
- **Trainer goal:** Set the tone and establish the baseline.
- **Learner goal:** Answer a core question quickly.

### 2. Breadth scan \`breadth-scan\`
- **Learner goal:** Define each topic clearly.
`;

const scenario = {
  scenario: "fundamental-depth",
  name: "Fundamental depth",
  description: "Run a progressive technical mock interview.",
  trainer_role: "interviewer",
  learner_role: "candidate",
  steps: [
    { id: "warm-up", name: "Warm-up", trainer_moves: ["greet"], learner_moves: ["answer"] },
    { id: "breadth-scan", name: "Breadth scan", trainer_moves: ["probe"], learner_moves: ["define"] },
  ],
};
const item = (id: string) => ({
  id,
  role: "trainer",
  context: "The candidate just named closures.",
  text: "Okay, tell me what a closure is.",
  metadata: { scenario_id: "fundamental-depth", step: "warm-up", move: "greet", source: "abc", kind: "session", ref: 4, words: 7 },
});
const input = (extra: Row = {}) => scenarioIngestSchema.parse({ personaSlug: "Vasanth", skill: SKILL, scenario, items: [item("x#1"), item("x#1")], ...extra });

beforeEach(() => {
  log.length = 0;
  agents = [];
  domains = [];
  specVersions = [];
  storedItems = null;
});

test("skill body drops the YAML header; step goals come from the step's own section", () => {
  const body = skillBody(SKILL);
  expect(body.startsWith("# Progressive Fundamental Depth Drilling")).toBe(true);
  expect(stepGoal(body, "warm-up")).toBe("Set the tone and establish the baseline.");
  // No trainer goal line: the first goal in that section is the learner's, which is still the step's goal text.
  expect(stepGoal(body, "breadth-scan")).toBe("Define each topic clearly.");
  expect(stepGoal(body, "missing")).toBeUndefined();
});

test("stores the ingestion files verbatim: SKILL.md with its header, unknown keys, untrimmed text", () => {
  const raw = { ...scenario, name: "  Fundamental depth ", future_field: { kept: true } };
  const parsed = scenarioIngestSchema.parse({ personaSlug: "Vasanth", skill: SKILL, scenario: raw, items: [{ ...item("x#1"), text: " Okay. ", extra: 1 }] });
  expect(parsed.scenario).toEqual(raw);
  expect(parsed.items[0]).toMatchObject({ text: " Okay. ", extra: 1 });
  const built = buildScenario("acme", parsed.scenario, SKILL);
  expect(built.agentData.skill).toBe(SKILL);
  expect(built.agentData.scenario).toEqual(raw);
  expect(built.agentData.source).toBe("scenario-ingest");
});

test("builds an org-prefixed agent the runtime can read", () => {
  const built = buildScenario("acme", scenario, SKILL);
  expect(built.slug).toBe("acme-fundamental-depth");
  expect(built.domainSlug).toBe("domain-acme-fundamental-depth");
  expect(built.agentData).toMatchObject({
    name: "Fundamental depth",
    objective: "Run a progressive technical mock interview.",
    stages: [
      { id: "warm-up", name: "Warm-up", objective: "Set the tone and establish the baseline." },
      { id: "breadth-scan", name: "Breadth scan", objective: "Define each topic clearly." },
    ],
  });
  expect("instruction" in built.agentData).toBe(false);
});

test("first ingest creates domain + agent after storing items (duplicate item ids allowed)", async () => {
  const result = await ingestScenario("org1", input());
  expect(result).toEqual({ slug: "acme-fundamental-depth", name: "Fundamental depth", version: 1, created: true, items: 2 });
  expect(log).toEqual(["chroma", "agent.create"]);
  expect(storedItems).toEqual({ orgId: "org1", agentSlug: "acme-fundamental-depth", count: 2 });
  expect(domains).toHaveLength(1);
  expect(agents[0]).toMatchObject({ personaId: "p1", domainSlug: "domain-acme-fundamental-depth", orgId: "org1" });
});

test("re-ingest is a no-op when unchanged, and versions the spec when changed", async () => {
  await ingestScenario("org1", input());
  agents[0].data = { ...(agents[0].data as Row), introVideo: "intro.mp4" };
  const same = await ingestScenario("org1", input());
  // introVideo is carried forward, so an identical re-send changes nothing.
  expect(same).toMatchObject({ version: 1, created: false });
  expect(specVersions).toHaveLength(0);

  const changed = await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }));
  expect(changed).toMatchObject({ version: 2, created: false, name: "Depth drill" });
  expect(specVersions).toEqual([expect.objectContaining({ entityType: "agents", entitySlug: "acme-fundamental-depth", version: 1 })]);
  expect((agents[0].data as Row).introVideo).toBe("intro.mp4");
});

test("refuses unknown personas and another org's scenario without writing anything", async () => {
  await expect(ingestScenario("org1", input({ personaSlug: "Nobody" }))).rejects.toMatchObject({ status: 404 });
  agents.push({ id: "z", slug: "acme-fundamental-depth", orgId: "org2", data: {} });
  await expect(ingestScenario("org1", input())).rejects.toMatchObject({ status: 409 });
  expect(log).toEqual([]);
});

test("route: secret, org header and payload are checked before ingesting", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const call = (headers: Record<string, string>, body: unknown) =>
    POST(new Request("http://x/api/internal/scenarios", { method: "POST", headers, body: JSON.stringify(body) }));
  const body = { personaSlug: "Vasanth", skill: SKILL, scenario, items: [item("x#1")] };

  expect((await call({ authorization: "Bearer wrong", "x-trainertwin-org-id": "org1" }, body)).status).toBe(401);
  expect((await call({ authorization: "Bearer s3cret" }, body)).status).toBe(400);
  expect((await call({ authorization: "Bearer s3cret", "x-trainertwin-org-id": "org1" }, { ...body, scenario: { name: "x" } })).status).toBe(400);
  const ok = await call({ authorization: "Bearer s3cret", "x-trainertwin-org-id": "org1" }, body);
  expect(ok.status).toBe(201);
  expect(await ok.json()).toMatchObject({ ok: true, scenario: { slug: "acme-fundamental-depth", items: 1 } });
});
