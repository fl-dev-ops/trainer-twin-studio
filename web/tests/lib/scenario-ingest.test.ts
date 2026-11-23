import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
type SkillRow = Row & { id: string; nextVersion: number; generation: number; currentVersionId: string | null };
type SkillVersionRow = Row & { id: string; skillId: string; version: number; contentHash: string; status: string };
const skills: SkillRow[] = [];
const skillVersions: SkillVersionRow[] = [];
type MappingRow = { agentId: string; agentVersion: number; orgId: string; skillVersionId: string };
type SourceRow = { skillVersionId: string; orgId: string; documentId: string; title: string; items: number };
const mappings: MappingRow[] = [];
const packageSources: SourceRow[] = [];
const skillItems = new Map<string, unknown[]>();
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
    findFirst: async ({ where }: { where: { orgId: string; isOwn?: boolean; slug: string | { equals: string; mode: string } } }) => {
      if (where.orgId !== "org1") return null;
      const slug = typeof where.slug === "string" ? where.slug : where.slug.equals.toLowerCase();
      const persona = [{ slug: "vasanth", id: "p1", isOwn: true }, { slug: "rohan", id: "p-rohan", isOwn: false, data: { role: "Prospect" } }].find(persona => persona.slug === slug);
      return persona && (where.isOwn === undefined || persona.isOwn === where.isOwn) ? persona : null;
    },
  },
  agent: {
    findUnique: async ({ where }: { where: { slug: string } }) => {
      const row = agents.find((a) => a.slug === where.slug);
      return row ? { ...row } : null;
    },
    // A published twin skill looks up its owner and the trainer's main twin (lib/agent-skills); none here is merged.
    findFirst: async ({ where }: { where: { slug?: string; id?: string } }) => {
      const row = agents.find((a) => (where.slug !== undefined && a.slug === where.slug) || (where.id !== undefined && a.id === where.id));
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      log.push("agent.create");
      const row = { id: crypto.randomUUID(), updatedAt: new Date(), ...data };
      agents.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      log.push("agent.update");
      const row = agents.find((a) => a.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
  },
  skill: {
    updateMany: async ({ where, data }: { where: { id: string; generation: number }; data: Row }) => {
      const rows = skills.filter(skill => skill.id === where.id && skill.generation === where.generation);
      rows.forEach(row => Object.assign(row, data));
      return { count: rows.length };
    },
    upsert: async ({ where, create, update }: { where: { orgId_ownerSlug: { orgId: string; ownerSlug: string } }; create: Row; update: Row }) => {
      let row = skills.find(skill => skill.orgId === where.orgId_ownerSlug.orgId && skill.ownerSlug === where.orgId_ownerSlug.ownerSlug);
      if (!row) {
        row = { id: crypto.randomUUID(), nextVersion: 1, generation: 0, currentVersionId: null, ...create };
        skills.push(row);
      } else Object.assign(row, update);
      return { ...row };
    },
    findUniqueOrThrow: async ({ where, include }: { where: { id: string }; include?: { currentVersion: boolean } }) => {
      const row = skills.find(skill => skill.id === where.id);
      if (!row) throw new Error(`Missing skill ${where.id}`);
      return { ...row, ...(include?.currentVersion ? { currentVersion: skillVersions.find(version => version.id === row.currentVersionId) ?? null } : {}) };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row & { nextVersion?: { increment: number } } }) => {
      const row = skills.find(skill => skill.id === where.id)!;
      const nextVersion = data.nextVersion ? row.nextVersion + data.nextVersion.increment : row.nextVersion;
      Object.assign(row, data, { nextVersion });
      return { ...row };
    },
  },
  skillVersion: {
    findMany: async ({ where }: { where: { skillId: string; artifacts: string; status: string; skill: { orgId: string; ownerSlug: string } } }) =>
      skillVersions.filter(version => version.skillId === where.skillId && version.artifacts === where.artifacts && version.status === where.status
        && skills.some(skill => skill.id === version.skillId && skill.orgId === where.skill.orgId && skill.ownerSlug === where.skill.ownerSlug)).map(row => ({ ...row })),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = skillVersions.find(version => version.id === where.id);
      if (!row) throw new Error(`Missing skill version ${where.id}`);
      return { ...row };
    },
    findFirst: async ({ where }: { where: { skillId: string; contentHash: string; status: { in: string[] } } }) => {
      const row = skillVersions.filter(version => version.skillId === where.skillId && version.contentHash === where.contentHash && where.status.in.includes(version.status)).sort((a, b) => b.version - a.version)[0];
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row & { skillId: string; version: number; contentHash: string } }) => {
      const row = { ...data, id: crypto.randomUUID(), status: "pending", indexStatus: "pending", failure: null, updatedAt: new Date() };
      skillVersions.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = skillVersions.find(version => version.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Row }) => {
      const rows = skillVersions.filter(version => version.id === where.id && version.status === where.status);
      rows.forEach(row => Object.assign(row, data, { updatedAt: new Date() }));
      return { count: rows.length };
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
  agentSkillVersion: {
    findUnique: async ({ where }: { where: { agentId_agentVersion: { agentId: string; agentVersion: number } } }) =>
      mappings.find(row => row.agentId === where.agentId_agentVersion.agentId && row.agentVersion === where.agentId_agentVersion.agentVersion) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { agentId_agentVersion: { agentId: string; agentVersion: number } } }) => {
      const row = mappings.find(row => row.agentId === where.agentId_agentVersion.agentId && row.agentVersion === where.agentId_agentVersion.agentVersion);
      if (!row) throw new Error("Missing mapping");
      return { ...row };
    },
    createMany: async ({ data, skipDuplicates }: { data: MappingRow[]; skipDuplicates: boolean }) => {
      let count = 0;
      for (const row of data) {
        const agent = agents.find(agent => agent.id === row.agentId);
        const version = skillVersions.find(version => version.id === row.skillVersionId);
        const skill = skills.find(skill => skill.id === version?.skillId);
        if (!agent || agent.orgId !== row.orgId || skill?.orgId !== row.orgId || skill.ownerSlug !== agent.slug || version?.status !== "ready" || row.agentVersion <= 0) throw new Error("Invalid history mapping");
        if (mappings.some(saved => saved.agentId === row.agentId && saved.agentVersion === row.agentVersion)) {
          if (!skipDuplicates) throw new Error("Duplicate history mapping");
          continue;
        }
        mappings.push({ ...row }); count++;
      }
      return { count };
    },
  },
  skillVersionSource: {
    findMany: async ({ where }: { where: { skillVersionId: string } }) =>
      packageSources.filter(row => row.skillVersionId === where.skillVersionId).map(row => ({ ...row })),
    createMany: async ({ data, skipDuplicates }: { data: SourceRow[]; skipDuplicates: boolean }) => {
      let count = 0;
      for (const row of data) {
        const version = skillVersions.find(version => version.id === row.skillVersionId);
        if (!skills.some(skill => skill.id === version?.skillId && skill.orgId === row.orgId) || row.items < 0) throw new Error("Invalid package source");
        if (packageSources.some(saved => saved.skillVersionId === row.skillVersionId && saved.documentId === row.documentId)) {
          if (!skipDuplicates) throw new Error("Duplicate package source");
          continue;
        }
        packageSources.push({ ...row }); count++;
      }
      return { count };
    },
  },
  skillSource: {
    findMany: async ({ where }: { where: Row }) => skillSources.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)),
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates: boolean }) => {
      for (const row of data) {
        if (skillSources.some(saved => saved.agentId === row.agentId && saved.version === row.version && saved.documentId === row.documentId)) {
          if (!skipDuplicates) throw new Error("Duplicate legacy source");
          continue;
        }
        skillSources.push({ ...row });
      }
    },
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  $queryRaw: async () => [],
};
mock.module("@/lib/db", () => ({
  withLock: async (keys: string[], work: (tx: typeof fakeDb) => Promise<unknown>) => {
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^skill-ownership:/);
    expect(keys[1]).toMatch(/^agent:/);
    return work(fakeDb);
  },
  isUniqueViolation: (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002", db: fakeDb }));
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
  getObjectText: async (key: string) => {
    const text = s3.get(key);
    if (text === undefined) throw new Error(`Missing S3 object ${key}`);
    return text;
  },
  kbPrefix: () => "",
  presignedGetUrl: async () => "",
}));
mock.module("@/lib/main-collection", () => ({
  invalidateCollectionCache: () => {},
  invalidatePersonaStyleCache: () => {},
  MainCollectionService: {
    writeSkillItems: async (orgId: string, skillVersionId: string, _scenarioId: string, items: unknown[], indexScope = skillVersionId) => {
      if (failItems) throw new Error("embedding failed");
      skillItems.set(`${orgId}/${skillVersionId}/${indexScope}`, items);
      return items.length;
    },
    skillItemCount: async (orgId: string, skillVersionId: string, indexScope = skillVersionId) => skillItems.get(`${orgId}/${skillVersionId}/${indexScope}`)?.length ?? 0,
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
const { orgPrefix } = await import("@/lib/s3");
const { readFileSync } = await import("node:fs");
const roleplayBuilder = { ...JSON.parse(readFileSync(new URL("../../data/roleplay/skills/wait-and-see-investor/builder.json", import.meta.url), "utf8")), persona: "rohan" };
const people = await import("@/lib/org-people");
mock.module("@/lib/org-people", () => ({ ...people, orgPerson: async () => ({ role: "admin", disabled: false, name: "Trainer" }) }));
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
  skills.length = 0;
  skillVersions.length = 0;
  mappings.length = 0;
  packageSources.length = 0;
  skillItems.clear();
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
  const prefix = result.artifacts;
  expect(prefix.startsWith(`${orgPrefix("org1")}/skills/${skills[0].id}/v1/attempt-`)).toBe(true);
  expect(prefix).toMatch(/\/attempt-[0-9a-f-]{36}$/);
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
  expect(agents[0].primarySkillId).toBe(skills[0].id);
  expect(skills[0].currentVersionId).toBe(skillVersions[0].id);
  expect(skillVersions[0]).toMatchObject({ status: "ready", indexStatus: "ready", itemCount: 2 });
  expect(skillItems.get(`org1/${skillVersions[0].id}/${prefix}`)).toEqual([item("x#1"), item("x#1")]);
  expect(mappings).toEqual([{ agentId: agents[0].id, agentVersion: 1, orgId: "org1", skillVersionId: skillVersions[0].id }]);
  expect(packageSources).toEqual([{ skillVersionId: skillVersions[0].id, orgId: "org1", documentId: "abc", title: "Session 3 · Osama", items: 2 }]);
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
  expect(changed).toMatchObject({ version: 2, created: false, name: "Depth drill" });
  expect(changed.artifacts.startsWith(`${orgPrefix("org1")}/skills/${skills[0].id}/v2/attempt-`)).toBe(true);
  expect(changed.artifacts).toMatch(/\/attempt-[0-9a-f-]{36}$/);
  expect(s3.get(`${changed.artifacts}/scenario.json`)).toBe(fileText.scenario({ ...scenario, name: "Depth drill" }));
  expect((agents[0].data as Row).artifacts).toBe(changed.artifacts);
  expect(specVersions).toEqual([expect.objectContaining({ entityType: "agents", entitySlug: "acme-fundamental-depth", version: 1 })]);
  expect((agents[0].data as Row).introVideo).toBe("intro.mp4");
  expect(mappings.map(({ agentVersion, skillVersionId }) => [agentVersion, skillVersionId])).toEqual([
    [1, skillVersions[0].id], [2, skillVersions[1].id],
  ]);
});

test("ready no-op refuses a conflicting immutable history mapping", async () => {
  await ingestScenario("org1", input());
  mappings[0].skillVersionId = "another-package";
  const originalFiles = new Map(s3);
  await expect(ingestScenario("org1", input())).rejects.toMatchObject({ code: "skill_package_unavailable" });
  expect(s3).toEqual(originalFiles);
  expect(specVersions).toHaveLength(0);
  expect(mappings[0].skillVersionId).toBe("another-package");
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
  const body = { personaSlug: "Vasanth", kind: "ROLEPLAY", skill: SKILL, scenario, items: [item("x#1")] };
  const auth = { authorization: "Bearer s3cret", "x-trainertwin-org-id": "org1", "x-trainertwin-user-id": "trainer" };

  expect((await call({ authorization: "Bearer wrong", "x-trainertwin-org-id": "org1" }, body)).status).toBe(401);
  expect((await call({ authorization: "Bearer s3cret" }, body)).status).toBe(400);
  expect((await call(auth, { ...body, scenario: { name: "x" } })).status).toBe(400);
  expect((await call(auth, { ...body, kind: "TWIN" })).status).toBe(400);
  const ok = await call(auth, body);
  expect(ok.status).toBe(201);
  const response = await ok.json();
  // items.json is archived with keys in the order ingest wrote them (scenario_id first), byte for byte.
  expect(s3.get(`${response.scenario.artifacts}/items.json`)).toBe(`${JSON.stringify(body.items, null, 1)}\n`);
  expect(response).toMatchObject({ ok: true, scenario: { slug: "acme-fundamental-depth", items: 1 } });
});

test("run route: archives plan.json, report.md and specs as ingest wrote them", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const call = (headers: Record<string, string>, body: unknown) =>
    POST_RUN(new Request("http://x/api/internal/scenario-runs", { method: "POST", headers, body: JSON.stringify(body) }));
  const plan = { scenarios: [{ id: "fundamental-depth", sessions: [] }] };
  const body = { runId: "run-1", plan, report: "# Report\n", specs: { "fundamental-depth": "# Spec\n" } };
  const auth = { authorization: "Bearer s3cret", "x-trainertwin-org-id": "org1", "x-trainertwin-user-id": "trainer" };

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

test("authored role plays accept org characters, but twins and other orgs cannot use them", async () => {
  const saved = await ingestScenario("org1", input({ kind: "ROLEPLAY", personaSlug: "Rohan" }));
  expect(saved.created).toBe(true);
  expect(agents[0]).toMatchObject({ kind: "ROLEPLAY", personaId: "p-rohan" });
  log.length = 0;
  await expect(ingestScenario("org1", input({ personaSlug: "Rohan" }))).rejects.toThrow("was not found");
  await expect(ingestScenario("org2", input({ kind: "ROLEPLAY", personaSlug: "Rohan" }))).rejects.toThrow("was not found");
  expect(log).toEqual([]);
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

test("a new version's items precede activation and old indexes await audited retention", async () => {
  await ingestScenario("org1", input());
  expect(pruned).toEqual([]); // a first publish has nothing to prune
  log.length = 0;
  await ingestScenario("org1", input({ scenario: { ...scenario, name: "Depth drill" } }));
  expect(storedItems).toMatchObject({ version: 2 });
  expect(log).toEqual(["s3", "chroma", "agent.update"]);
  expect(pruned).toEqual([]);
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
  expect(skills[0].currentVersionId).toBe(skillVersions[0].id);
  expect(skillVersions[0]).toMatchObject({ status: "ready", indexStatus: "ready" });
  expect(skillVersions[1]).toMatchObject({
    status: "failed",
    indexStatus: "failed",
    failure: "Skill publication failed before activation. Retry the original package; inspect server logs for provider details.",
  });
});

test("changing only items.json (or patterns.md) makes a new version instead of overwriting this one's files", async () => {
  const first = await ingestScenario("org1", input());
  const v1Items = s3.get(`${first.artifacts}/items.json`);
  expect(v1Items).toBe(fileText.items(input().items));
  const changed = await ingestScenario("org1", input({ items: [item("x#2")] }));
  expect(changed).toMatchObject({ version: 2 });
  expect(s3.get(`${first.artifacts}/items.json`)).toBe(v1Items); // the backup stays
  expect(s3.get(`${changed.artifacts}/items.json`)).toBe(fileText.items(input({ items: [item("x#2")] }).items));
  const patterns = await ingestScenario("org1", input({ items: [item("x#2")], patterns: "# New evidence\n" }));
  expect(patterns).toMatchObject({ version: 3 });
});

test("each published version records which knowledge base documents built it (items per document)", async () => {
  await ingestScenario("org1", input({ items: [item("x#1"), item("x#2"), { ...item("x#3"), metadata: { ...item("x#3").metadata, source: "not-in-the-kb" } }] }));
  // Only the org's KB documents; the unknown source gets no row.
  expect(skillSources).toEqual([{ agentId: agents[0].id, version: 1, documentId: "abc", orgId: "org1", title: "Session 3 · Osama", items: 2 }]);
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
