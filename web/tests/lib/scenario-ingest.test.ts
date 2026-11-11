import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const log: string[] = [];
let agents: Row[] = [];
let domains: Row[] = [];
let specVersions: Row[] = [];
let storedItems: { orgId: string; agentSlug: string; version: number; count: number } | null = null;
let pruned: { agentSlug: string; keepFrom: number }[] = [];
let failItems = false;
let skillSources: Row[] = [];
const s3 = new Map<string, string>();

const fakeDb = {
  organization: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      ({ org1: { id: "org1", slug: "acme" }, org2: { id: "org2", slug: "other" } })[where.id] ?? null,
  },
  persona: {
    // Skill twin: only the org's own persona (case-insensitive). Role play: any persona of the org, by exact slug.
    findFirst: async ({ where }: { where: { orgId: string; isOwn?: boolean; slug: string | { equals: string; mode: string } } }) => {
      if (typeof where.slug === "string") return where.orgId === "org1" && where.slug === "rohan" ? { id: "p-rohan", data: { role: "Prospect" } } : null;
      return where.orgId === "org1" && where.isOwn === true && where.slug.mode === "insensitive" && where.slug.equals.toLowerCase() === "vasanth" ? { id: "p1" } : null;
    },
  },
  agent: {
    findUnique: async ({ where }: { where: { slug: string } }) => agents.find((a) => a.slug === where.slug) ?? null,
    create: async ({ data }: { data: Row }) => {
      log.push("agent.create");
      const row = { id: `a${agents.length + 1}`, ...data };
      agents.push(row);
      return row;
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
  // The org's knowledge base: "abc" (the test items' source) is a document of org1.
  knowledgeDocument: {
    findMany: async ({ where }: { where: { id: { in: string[] }; kb: { orgId: string } } }) =>
      where.kb.orgId === "org1" ? [{ id: "abc", title: "Session 3 · Osama" }].filter((doc) => where.id.in.includes(doc.id)) : [],
  },
  skillSource: { createMany: async ({ data }: { data: Row[] }) => void skillSources.push(...data) },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};
mock.module("@/lib/db", () => ({
  withLock: async () => { throw new Error("Unexpected locked write in read-only fixture"); },
  isUniqueViolation: (error: any) => error?.code === "P2002", db: fakeDb }));
const realS3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...realS3,
  s3Configured: true,
  scenarioArtifactsPrefix: (orgId: string, slug: string, version: number) => `p/${orgId}/scenario-ingest/scenarios/${slug}/v${version}`,
  scenarioRunPrefix: (orgId: string, runId: string) => `p/${orgId}/scenario-ingest/runs/${runId}`,
  putObject: async (key: string, body: string) => {
    if (!log.includes("s3")) log.push("s3");
    s3.set(key, body);
  },
  deletePrefix: async () => {},
  getObjectText: async () => "",
  kbPrefix: () => "",
  presignedGetUrl: async () => "",
}));
mock.module("@/lib/main-collection", () => ({
  invalidateCollectionCache: () => {},
  invalidatePersonaStyleCache: () => {},
  MainCollectionService: {
    writeScenarioItems: async (orgId: string, agentSlug: string, _scenarioId: string, version: number, items: unknown[]) => {
      if (failItems) throw new Error("embedding failed");
      log.push("chroma");
      storedItems = { orgId, agentSlug, version, count: items.length };
      return items.length;
    },
    pruneScenarioItems: async (_orgId: string, agentSlug: string, keepFrom: number) => {
      log.push("prune");
      pruned.push({ agentSlug, keepFrom });
    },
  },
}));

const { buildScenario, fileText, ingestScenario, ROLEPLAY_SOURCE, saveRoleplay, scenarioIngestSchema, skillBody, stepGoal } = await import("@/lib/scenario-ingest");
const { readFileSync } = await import("node:fs");
const roleplayBuilder = { ...JSON.parse(readFileSync(new URL("../../data/roleplay/skills/wait-and-see-investor/builder.json", import.meta.url), "utf8")), persona: "rohan" };
const { POST } = await import("@/app/api/internal/scenarios/route");
const { POST: POST_RUN } = await import("@/app/api/internal/scenario-runs/route");

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
  pruned = [];
  failItems = false;
  skillSources = [];
  s3.clear();
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
  expect("domain" in built.agentData).toBe(false); // v2 has no domains
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

test("first ingest creates the agent (no domain) after storing items (duplicate item ids allowed)", async () => {
  // The agent sends its source folder name; the persona is "Vasanth".
  const result = await ingestScenario("org1", input({ personaSlug: "vasanth", patterns: "# Patterns\n", runId: "run-1" }));
  const prefix = "p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v1";
  expect(result).toEqual({ slug: "acme-fundamental-depth", name: "Fundamental depth", version: 1, created: true, items: 2, artifacts: prefix, runId: "run-1" });
  // Files, then items, then the rows.
  expect(log).toEqual(["s3", "chroma", "agent.create"]);
  expect([...s3.keys()].sort()).toEqual([`${prefix}/SKILL.md`, `${prefix}/items.json`, `${prefix}/patterns.md`, `${prefix}/scenario.json`]);
  expect(s3.get(`${prefix}/SKILL.md`)).toBe(SKILL);
  expect(s3.get(`${prefix}/scenario.json`)).toBe(`${JSON.stringify(scenario, null, 2)}\n`);
  expect(JSON.parse(s3.get(`${prefix}/items.json`)!)).toEqual([item("x#1"), item("x#1")]);
  expect((agents[0].data as Row).artifacts).toBe(prefix);
  expect(storedItems).toEqual({ orgId: "org1", agentSlug: "acme-fundamental-depth", version: 1, count: 2 });
  expect(domains).toHaveLength(0);
  expect(agents[0]).toMatchObject({ personaId: "p1", orgId: "org1", kind: "TWIN" });
  expect("domainSlug" in agents[0]).toBe(false);
});

test("re-ingest is a no-op when unchanged, and versions the spec when changed", async () => {
  await ingestScenario("org1", input());
  // Postgres jsonb hands keys back in its own order; that must not count as a change.
  const stored = { ...(agents[0].data as Row), introVideo: "intro.mp4" };
  agents[0].data = Object.fromEntries(Object.entries(stored).reverse());
  const same = await ingestScenario("org1", input());
  // introVideo is carried forward, so an identical re-send changes nothing.
  expect(same).toMatchObject({ version: 1, created: false });
  expect(specVersions).toHaveLength(0);
  expect(log.filter((entry) => entry === "agent.update")).toHaveLength(0);

  const changed = await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }));
  expect(changed).toMatchObject({ version: 2, created: false, name: "Depth drill", artifacts: "p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v2" });
  expect(s3.has("p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v2/scenario.json")).toBe(true);
  expect((agents[0].data as Row).artifacts).toBe("p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v2");
  expect(specVersions).toEqual([expect.objectContaining({ entityType: "agents", entitySlug: "acme-fundamental-depth", version: 1 })]);
  expect((agents[0].data as Row).introVideo).toBe("intro.mp4");
});

test("refuses unknown personas and another org's scenario without writing anything", async () => {
  await expect(ingestScenario("org1", input({ personaSlug: "Nobody" }))).rejects.toMatchObject({ status: 404 });
  agents.push({ id: "z", slug: "acme-fundamental-depth", orgId: "org2", kind: "TWIN", data: {} });
  await expect(ingestScenario("org1", input())).rejects.toMatchObject({ status: 409 });
  expect(log).toEqual([]);
});

test("never overwrites a role play that shares the slug", async () => {
  agents.push({ id: "r", slug: "acme-fundamental-depth", orgId: "org1", kind: "ROLEPLAY", data: {} });
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
  // items.json is archived with keys in the order ingest wrote them (scenario_id first), byte for byte.
  expect(s3.get("p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v1/items.json")).toBe(`${JSON.stringify(body.items, null, 1)}\n`);
  expect(await ok.json()).toMatchObject({ ok: true, scenario: { slug: "acme-fundamental-depth", items: 1 } });
});

test("run route: archives plan.json, report.md and specs as ingest wrote them", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const call = (headers: Record<string, string>, body: unknown) =>
    POST_RUN(new Request("http://x/api/internal/scenario-runs", { method: "POST", headers, body: JSON.stringify(body) }));
  const plan = { scenarios: [{ id: "fundamental-depth", sessions: [] }] };
  const body = { runId: "run-1", plan, report: "# Report\n", specs: { "fundamental-depth": "# Spec\n" } };
  const auth = { authorization: "Bearer s3cret", "x-trainertwin-org-id": "org1" };

  expect((await call({ ...auth, authorization: "Bearer no" }, body)).status).toBe(401);
  expect((await call(auth, { ...body, runId: "../escape" })).status).toBe(400);
  expect((await call(auth, { ...body, specs: { "../x": "y" } })).status).toBe(400);
  const ok = await call(auth, body);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, run: { runId: "run-1", files: 3, prefix: "p/org1/scenario-ingest/runs/run-1" } });
  expect(s3.get("p/org1/scenario-ingest/runs/run-1/plan.json")).toBe(fileText.plan(plan));
  expect(s3.get("p/org1/scenario-ingest/runs/run-1/report.md")).toBe("# Report\n");
  expect(s3.get("p/org1/scenario-ingest/runs/run-1/specs/fundamental-depth.md")).toBe("# Spec\n");
});

test("re-ingesting a skill twin keeps its Before and After settings and intro video (they belong to other phases)", async () => {
  await ingestScenario("org1", input());
  Object.assign(agents[0].data as Row, { before: { preUpload: true }, after: { report: "twin" }, introVideo: "v.mp4" });
  const changed = await ingestScenario("org1", input({ skill: `${SKILL}\nmore` }));
  expect(changed.version).toBe(2);
  expect(agents[0].data).toMatchObject({ before: { preUpload: true }, after: { report: "twin" }, introVideo: "v.mp4" });
});

test("role play: rendered from the builder and stored like a skill twin, kind ROLEPLAY, on any org persona", async () => {
  const saved = await saveRoleplay("org1", roleplayBuilder);
  expect(saved).toMatchObject({ slug: "acme-the-wait-and-see-investor", version: 1, created: true, items: 1 + roleplayBuilder.exampleLines.length });
  const agent = agents[0];
  expect(agent).toMatchObject({ kind: "ROLEPLAY", personaId: "p-rohan" });
  expect("domainSlug" in agent).toBe(false);
  const data = agent.data as Row;
  expect(data.source).toBe(ROLEPLAY_SOURCE);
  expect(data.after).toEqual({ report: "roleplay", goals: roleplayBuilder.learnerGoals, rubric: roleplayBuilder.rubric });
  expect((data.scenario as Row).trainer_role).toBe("Prospect");
  expect(log).toEqual(["s3", "chroma", "agent.create"]);
  expect(s3.get(`${saved.artifacts}/SKILL.md`)).toContain("## What is really going on");
  expect(JSON.parse(s3.get(`${saved.artifacts}/items.json`)!)[0]).toMatchObject({ role: "client" });

  // Editing (slug given, short or full) updates the same agent; unchanged saves keep the version.
  expect((await saveRoleplay("org1", roleplayBuilder, saved.slug)).version).toBe(1);
  const edited = await saveRoleplay("org1", { ...roleplayBuilder, opening: "Hello?" }, "the-wait-and-see-investor");
  expect(edited).toMatchObject({ slug: saved.slug, version: 2, created: false });
  expect(agents).toHaveLength(1);
  // A second new role play with the same name gets its own slug.
  expect((await saveRoleplay("org1", roleplayBuilder)).slug).toBe("acme-the-wait-and-see-investor-2");
});

test("role play and twin skill never overwrite each other; bad input and unknown personas write nothing", async () => {
  await ingestScenario("org1", input());
  await expect(saveRoleplay("org1", roleplayBuilder, "fundamental-depth")).rejects.toThrow("is a twin skill, not a role play");
  await expect(saveRoleplay("org1", { ...roleplayBuilder, persona: "nobody" })).rejects.toThrow("was not found");
  await expect(saveRoleplay("org1", { ...roleplayBuilder, learnerGoals: [] })).rejects.toThrow("learner goal");
  expect(agents).toHaveLength(1);
});

test("the copilot's roleplay-creator publishes a ROLEPLAY (same package, kind ROLEPLAY); default stays TWIN", async () => {
  const result = await ingestScenario("org1", input({ kind: "ROLEPLAY" }));
  expect(result.created).toBe(true);
  expect(agents[0]).toMatchObject({ kind: "ROLEPLAY", personaId: "p1" });
  expect((agents[0].data as Row).source).toBe("scenario-ingest");
  expect(() => input({ kind: "DOMAIN" })).toThrow();
});

test("publishing onto an archived skill brings it back, whether or not its content changed", async () => {
  await ingestScenario("org1", input());
  agents[0].archivedAt = new Date(); // deleted in the studio (archive is a soft delete; the slug stays taken)
  await ingestScenario("org1", input()); // same content
  expect(agents[0].archivedAt).toBeNull();
  agents[0].archivedAt = new Date();
  const changed = await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }));
  expect(changed).toMatchObject({ version: 2 });
  expect(agents[0].archivedAt).toBeNull();
});

test("a new version's items go in before the row switches to it; versions before the previous one are pruned after", async () => {
  await ingestScenario("org1", input());
  expect(pruned).toEqual([]); // a first publish has nothing to prune
  log.length = 0;
  await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }));
  expect(storedItems).toMatchObject({ version: 2 });
  expect(log).toEqual(["s3", "chroma", "agent.update", "prune"]);
  expect(pruned).toEqual([{ agentSlug: "acme-fundamental-depth", keepFrom: 1 }]); // keeps v2 (live) and v1 (previous)
  log.length = 0;
  await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } })); // unchanged
  expect(log).not.toContain("prune");
});

test("a failed item write leaves the live version untouched", async () => {
  await ingestScenario("org1", input());
  failItems = true;
  await expect(ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }))).rejects.toThrow(/embedding failed/);
  expect(agents[0]).toMatchObject({ version: 1, name: "Fundamental depth" });
  expect(specVersions).toHaveLength(0);
});

test("changing only items.json (or patterns.md) makes a new version instead of overwriting this one's files", async () => {
  await ingestScenario("org1", input());
  const v1Items = s3.get("p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v1/items.json");
  const changed = await ingestScenario("org1", input({ items: [item("x#2")] }));
  expect(changed).toMatchObject({ version: 2 });
  expect(s3.get("p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v1/items.json")).toBe(v1Items); // the backup stays
  expect(JSON.parse(s3.get("p/org1/scenario-ingest/scenarios/acme-fundamental-depth/v2/items.json")!)).toEqual([item("x#2")]);
  const patterns = await ingestScenario("org1", input({ items: [item("x#2")], patterns: "# New evidence\n" }));
  expect(patterns).toMatchObject({ version: 3 });
});

test("each published version records which knowledge base documents built it (items per document)", async () => {
  await ingestScenario("org1", input({ items: [item("x#1"), item("x#2"), { ...item("x#3"), metadata: { ...item("x#3").metadata, source: "not-in-the-kb" } }] }));
  // Only the org's KB documents; the unknown source gets no row.
  expect(skillSources).toEqual([{ agentId: "a1", version: 1, documentId: "abc", orgId: "org1", title: "Session 3 · Osama", items: 2 }]);
  await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }));
  expect(skillSources.map((row) => row.version)).toEqual([1, 2]);
  await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } })); // unchanged: no new rows
  expect(skillSources).toHaveLength(2);
});

test("an update's change record is stored with its new version (changes.json), never over an unchanged one", async () => {
  const { ingestTwinSkill } = await import("@/lib/scenario-ingest");
  const twin = (extra: Row = {}) => ({
    personaSlug: "vasanth",
    skill: "---\nname: objection-handling\ndescription: \"When clients push back\"\n---\n## Too expensive\nI clarify.\n",
    manifest: { skill: "objection-handling", name: "Objection Handling", description: "When clients push back", situations: [{ id: "too-expensive", name: "Too expensive" }] },
    items: [{ ...item("t#1"), metadata: { ...item("t#1").metadata, step: "too-expensive" } }],
    ...extra,
  }) as never;
  await ingestTwinSkill("org1", twin());
  const changes = { base: { slug: "acme-objection-handling", version: 1 }, edits: [{ file: "SKILL.md", find: "I clarify.", replace: "I clarify, then ask.", why: "new session" }] };
  const v2 = await ingestTwinSkill("org1", twin({ skill: "---\nname: objection-handling\ndescription: \"When clients push back\"\n---\n## Too expensive\nI clarify, then ask.\n", changes }));
  expect(v2.version).toBe(2);
  expect(JSON.parse(s3.get(`${v2.artifacts}/changes.json`)!)).toEqual(changes);
  expect(s3.has(`${(await ingestTwinSkill("org1", twin({ changes }))).artifacts}/changes.json`)).toBe(true); // v3 (content differs from v2)
  const before = s3.size;
  await ingestTwinSkill("org1", twin({ changes })); // unchanged since v3: nothing new written for it
  expect([...s3.keys()].filter((key) => key.endsWith("changes.json"))).toHaveLength(2);
  expect(s3.size).toBe(before);
});
