import { expect, mock, test } from "bun:test";

// Contract: the copilot (scenario-ingest agent) publisher against the real web routes.
// Postgres, S3 and Chroma are faked; everything between them is the production code of both services.
type Row = Record<string, unknown>;
type SkillRow = Row & { id: string; nextVersion: number; generation: number; currentVersionId: string | null };
type SkillVersionRow = Row & { id: string; skillId: string; version: number; contentHash: string; status: string };
const skills: SkillRow[] = [];
const skillVersions: SkillVersionRow[] = [];
type MappingRow = { agentId: string; agentVersion: number; orgId: string; skillVersionId: string };
type SourceRow = { skillVersionId: string; orgId: string; documentId: string; title: string; items: number };
const mappings: MappingRow[] = [];
const packageSources: SourceRow[] = [];
const legacySources: Row[] = [];
const skillItems = new Map<string, unknown[]>();
const agents: Row[] = [];
const s3 = new Map<string, string>();
let chroma: { agentSlug: string; count: number } | null = null;
let knowledgeWhere: Row | null = null;
let personaWhere: Row | null = null;
let savedSession: Row | null = null;
const searches: { orgId: string; scope: { slug: string; version: number }[]; options: { role?: string; steps?: unknown[] } }[] = [];
const managedSearches: { orgId: string; scope: { skillVersionId: string; indexScope: string; itemCount: number }[]; options: { role?: string; steps?: unknown[] } }[] = [];
const vectors: { orgId: string; slug: string; version: number; items: unknown[] }[] = [];
const knowledgeDocs: { id: string; title: string; s3MarkdownKey: string; updatedAt: Date }[] = [];

const fakeDb = {
  organization: { findUnique: async () => ({ id: "org1", slug: "acme" }) },
  persona: {
    findFirst: async ({ where }: { where: Row & { slug: { equals: string } } }) => {
      personaWhere = where;
      return where.slug.equals.toLowerCase() === "vasanth" ? { id: "p1", slug: "vasanth", name: "Vasanth", version: 1, data: { name: "Vasanth" }, isOwn: true } : null;
    },
  },
  interviewSession: { findFirst: async ({ where }: { where: Row }) => savedSession && Object.entries(where).every(([key, value]) => savedSession![key] === value) ? savedSession : null },
  knowledgeBase: { findFirst: async () => null },
  agent: {
    findFirst: async ({ where }: { where: { orgId: string; slug: string | { equals: string } } }) => agents.find(agent => agent.orgId === where.orgId && agent.slug === (typeof where.slug === "string" ? where.slug : where.slug.equals)) ?? null,
    findUnique: async ({ where }: { where: { slug: string } }) => {
      const row = agents.find((a) => a.slug === where.slug);
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: crypto.randomUUID(), updatedAt: new Date(), ...data };
      agents.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = agents.find(agent => agent.id === where.id)!;
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
  domain: { findUnique: async () => null, create: async () => {} },
  specVersion: { create: async () => {} },
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
    findMany: async ({ where }: { where: Row }) => legacySources.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)),
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates: boolean }) => {
      for (const row of data) {
        if (legacySources.some(saved => saved.agentId === row.agentId && saved.version === row.version && saved.documentId === row.documentId)) {
          if (!skipDuplicates) throw new Error("Duplicate legacy source");
          continue;
        }
        legacySources.push({ ...row });
      }
    },
  },
  knowledgeDocument: {
    findMany: async (args: { where: Row }) => {
      knowledgeWhere = args.where;
      return knowledgeDocs;
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
  scenarioArtifactsPrefix: (orgId: string, slug: string, version: number) => `p/${orgId}/scenarios/${slug}/v${version}`,
  scenarioRunPrefix: (orgId: string, runId: string) => `p/${orgId}/runs/${runId}`,
  putObject: async (key: string, body: string) => void s3.set(key, body),
  deletePrefix: async () => {},
  getObjectText: async (key: string) => {
    const text = s3.get(key);
    if (text === undefined) throw new Error(`Missing S3 object ${key}`);
    return text;
  },
  kbPrefix: () => "",
  presignedGetUrl: async (key: string) => `https://s3.test/${key}`,
}));
mock.module("@/lib/main-collection", () => ({
  invalidateCollectionCache: () => {},
  invalidatePersonaStyleCache: () => {},
  MainCollectionService: {
    writeSkillItems: async (orgId: string, skillVersionId: string, _scenarioId: string, items: unknown[], indexScope = skillVersionId) => {
      skillItems.set(`${orgId}/${skillVersionId}/${indexScope}`, items);
      return items.length;
    },
    skillItemCount: async (orgId: string, skillVersionId: string, indexScope = skillVersionId) => skillItems.get(`${orgId}/${skillVersionId}/${indexScope}`)?.length ?? 0,
    writeScenarioItems: async (orgId: string, agentSlug: string, _id: string, version: number, items: unknown[]) => {
      chroma = { agentSlug, count: items.length };
      vectors.push({ orgId, slug: agentSlug, version, items });
      return items.length;
    },
    searchScenarioItems: async (orgId: string, scope: { slug: string; version: number }[], _query: string, options: { role?: string; steps?: unknown[] }) => {
      searches.push({ orgId, scope, options });
      return vectors.filter(vector => vector.orgId === orgId && scope.some(entry => entry.slug === vector.slug && entry.version === vector.version))
         .flatMap(vector => vector.items as { role: string; text: string }[]).filter(item => item.role === options.role);
    },
    searchSkillItems: async (orgId: string, scope: { skillVersionId: string; indexScope: string; itemCount: number }[], _query: string, options: { role?: string; steps?: unknown[] }) => {
      managedSearches.push({ orgId, scope, options });
      return scope.flatMap(entry => {
        const items = skillItems.get(`${orgId}/${entry.skillVersionId}/${entry.indexScope}`);
        if (!items || items.length !== entry.itemCount) throw new Error("Unavailable managed index");
        return items as { role: string; text: string }[];
      }).filter(item => item.role === options.role);
    },
    pruneScenarioItems: async () => {},
  },
}));

const realKnowledge = await import("@/lib/knowledge");
mock.module("@/lib/knowledge", () => ({ ...realKnowledge, embedTexts: async () => [[0]] }));
const realCache = await import("next/cache");
mock.module("next/cache", () => ({ ...realCache, unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn }));
const { POST: studio } = await import("@/app/api/copilot/studio/route");
const { roleplaySkill, formatRoleplaySession } = await import("../../../chat/agent/lib/roleplay");
const { isRunnableAgentData } = await import("@/lib/specs");
const { POST: scenarios } = await import("@/app/api/internal/scenarios/route");
const { POST: runs } = await import("@/app/api/internal/scenario-runs/route");
const { publishToStudio, runIdFor } = await import("../../../copilot/agent/lib/studio-publish");

// Routes the publisher's fetch straight into the web handlers.
const routes: Record<string, (request: Request) => Promise<Response>> = {
  "/api/internal/scenario-runs": runs,
  "/api/internal/scenarios": scenarios,
};
const fetcher = async (url: string, init: RequestInit) => routes[new URL(url).pathname](new Request(url, init));

// A publication as scenario-ingest's preparePublication returns it.
const scenarioJson = {
  scenario: "fundamental-depth",
  name: "Fundamental depth",
  description: "Run a progressive technical mock interview.",
  trainer_role: "interviewer",
  learner_role: "candidate",
  steps: [{ id: "warm-up", name: "Warm-up", trainer_moves: ["greet"], learner_moves: ["answer"] }],
};
const items = [
  {
    id: "fundamental-depth/abc#4",
    role: "trainer",
    context: "The candidate just named closures.",
    text: "Okay, tell me what a closure is.",
    metadata: { scenario_id: "fundamental-depth", step: "warm-up", move: "greet", source: "abc", kind: "session", ref: 4, words: 7 },
  },
];
const skill = `---\nname: fundamental-depth\ndescription: "Run a progressive technical mock interview."\n---\n# Fundamental depth\n\n## Steps\n### 1. Warm-up \`warm-up\`\n- **Trainer goal:** Set the tone.\n`;
const files = [
  { path: "report.md", text: "# Report\n" },
  { path: "specs/fundamental-depth.md", text: "# Spec\n" },
  { path: "fundamental-depth/SKILL.md", text: skill },
  { path: "fundamental-depth/scenario.json", text: `${JSON.stringify(scenarioJson, null, 2)}\n` },
  { path: "fundamental-depth/items.json", text: `${JSON.stringify(items, null, 1)}\n` },
  { path: "fundamental-depth/patterns.md", text: "# Patterns\n" },
  { path: "plan.json", text: `${JSON.stringify({ scenarios: [{ id: "fundamental-depth" }] }, null, 1)}\n` },
];

test("an ingest publication lands in S3, Chroma and Postgres, files byte for byte", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const target = { url: "http://web", secret: "s3cret", orgId: "org1", persona: "vasanth", runId: runIdFor("sess:01/abc") };
  expect(target.runId).toBe("sess-01-abc");

  const result = await publishToStudio(target, files, fetcher);
  expect(result).toEqual({
    run: { ok: true },
    scenarios: [{ id: "fundamental-depth", ok: true, slug: "acme-fundamental-depth", version: 1, created: true, items: 1 }],
  });

  const v1 = (agents[0].data as { artifacts: string }).artifacts;
  expect(v1.startsWith(`${realS3.orgPrefix("org1")}/skills/${skills[0].id}/v1/attempt-`)).toBe(true);
  expect(v1).toMatch(/\/attempt-[0-9a-f-]{36}$/);
  for (const [name, path] of [["SKILL.md", "fundamental-depth/SKILL.md"], ["scenario.json", "fundamental-depth/scenario.json"], ["items.json", "fundamental-depth/items.json"], ["patterns.md", "fundamental-depth/patterns.md"]]) {
    expect(s3.get(`${v1}/${name}`)).toBe(files.find((f) => f.path === path)!.text);
  }
  expect(s3.get("p/org1/runs/sess-01-abc/plan.json")).toBe(files.find((f) => f.path === "plan.json")!.text);
  expect(s3.get("p/org1/runs/sess-01-abc/report.md")).toBe("# Report\n");
  expect(s3.get("p/org1/runs/sess-01-abc/specs/fundamental-depth.md")).toBe("# Spec\n");
  expect(chroma).toEqual({ agentSlug: "acme-fundamental-depth", count: 1 });
  // The copilot's roleplay-creator publishes role plays, never twin skills.
  expect(agents[0]).toMatchObject({ slug: "acme-fundamental-depth", personaId: "p1", orgId: "org1", kind: "ROLEPLAY" });
  expect(agents[0].primarySkillId).toBe(skills[0].id);
  expect(skills[0].currentVersionId).toBe(skillVersions[0].id);
  expect(skillVersions[0]).toMatchObject({ status: "ready", indexStatus: "ready", itemCount: 1 });
  expect(skillItems.get(`org1/${skillVersions[0].id}/${v1}`)).toEqual(items);
  expect(mappings).toEqual([{ agentId: agents[0].id, agentVersion: 1, orgId: "org1", skillVersionId: skillVersions[0].id }]);
  const published = agents[0].data as Row;
  expect(published.skill).toBe(skill);
  expect(isRunnableAgentData("ROLEPLAY", published)).toBe(true);
  expect(personaWhere).not.toHaveProperty("isOwn");

  // A pre-managed session keeps its legacy snapshot/search scope after publication.
  savedSession = { id: "call1", orgId: "org1", agentSlug: "acme-fundamental-depth", personaSlug: "vasanth", agentVersion: 1, skillPinsVersion: null, context: null, documents: [], compiledSnapshot: { agent: { slug: "acme-fundamental-depth", version: 1, data: published } } };
  agents[0] = { ...agents[0], version: 2, data: { ...published, source: "roleplay-skill", skill: "# Changed live skill", scenario: { roleplay: { clientName: "Changed client" }, steps: [] } } };
  process.env.COPILOT_SERVICE_SECRET = "studio-test-secret";
  const request = (body: Row, orgId = "org1") => studio(new Request("https://studio.test/api/copilot/studio", { method: "POST", headers: { authorization: "Bearer studio-test-secret", "content-type": "application/json", "x-trainertwin-org-id": orgId }, body: JSON.stringify(body) }));
  const contextResponse = await request({ action: "getSessionContext", sessionId: "call1" });
  expect(contextResponse.status).toBe(200);
  const context = await contextResponse.json();
  expect(context.agent.version).toBe(1);
  expect(context.agent.data.skill).toBe(skill);
  const roleplay = roleplaySkill(context.agent.kind, context.agent.data)!;
  const prompt = formatRoleplaySession({ agentName: scenarioJson.name, agentSlug: context.agent.slug, agentVersion: context.agent.version, personaBrief: context.personaBrief }, roleplay, { learnerBlock: "Learner: Test candidate" });
  expect(prompt).toContain(skill);
  expect(prompt).toContain("You play interviewer. The learner plays candidate");
  expect(prompt).not.toContain("CLIENT ROLE-PLAY MODE");

  const search = { action: "searchScenarioItems", agentSlug: "acme-fundamental-depth", sessionId: "call1", query: "candidate named closures" };
  const results = await (await request(search)).json();
  expect(results.examples.map((item: { text: string }) => item.text)).toEqual([items[0].text]);
  expect(searches.at(-1)).toMatchObject({ orgId: "org1", scope: [{ slug: "acme-fundamental-depth", version: 1 }], options: { role: "trainer", steps: scenarioJson.steps } });
  const wrongOrg = await request(search, "other-org");
  expect(wrongOrg.status).toBe(404);
  expect(await wrongOrg.json()).toMatchObject({ code: "not_found" });
  await request({ ...search, sessionId: undefined });
  expect(managedSearches.at(-1)).toMatchObject({
    orgId: "org1", scope: [{ skillVersionId: skillVersions[0].id, indexScope: v1, itemCount: 1 }],
    options: { role: "trainer", steps: scenarioJson.steps },
  });
  await request({ ...search, role: "learner" });
  expect(searches.at(-1)?.options.role).toBe("learner");
  savedSession = null;
});

test("failures come back per call instead of throwing", async () => {
  const result = await publishToStudio({ url: "http://web", secret: "wrong", orgId: "org1", persona: "vasanth", runId: "r1" }, files, fetcher);
  expect(result.run).toEqual({ ok: false, error: "Unauthorized" });
  expect(result.scenarios).toEqual([{ id: "fundamental-depth", ok: false, error: "Unauthorized" }]);

  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const unknown = await publishToStudio({ url: "http://web", secret: "s3cret", orgId: "org1", persona: "nobody", runId: "r1" }, files, fetcher);
  expect(unknown.scenarios[0]).toMatchObject({ ok: false, error: expect.stringContaining("Persona") });
});


// Knowledge base → copilot sandbox: the copilot's loader against the real web route, then into the sandbox inventory.
const { GET: knowledgeSources } = await import("@/app/api/internal/knowledge-sources/route");
const { pullKnowledgeBase } = await import("../../../copilot/agent/lib/origin");
const { ensureSynced } = await import("../../../copilot/agent/lib/ingest");
const { knowledgeBaseFor } = await import("../../../copilot/agent/lib/session-io");

const kbFetch = async (url: string, init?: RequestInit) => {
  const parsed = new URL(url);
  if (parsed.host === "s3.test") {
    const text = s3.get(parsed.pathname.slice(1));
    return text == null ? new Response("missing", { status: 404 }) : new Response(text);
  }
  return knowledgeSources(new Request(url, init));
};
const kb = { url: "https://dash.test", secret: "s3cret", orgId: "org1" };
const session = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? "speaker_2: Fine, the viewing went well and the client liked it a lot." : "speaker_1: So what did the client say after the viewing?")).join("\n");

test("the copilot pulls every Markdown copy in the org's knowledge base into its sandbox", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  knowledgeDocs.splice(0, knowledgeDocs.length,
    { id: "d1", title: "Lesson 2: role play", s3MarkdownKey: "p/org1/ingest/files/d1/content.md", updatedAt: new Date("2026-11-01") },
    { id: "d2", title: "Pricing [2026] / guide", s3MarkdownKey: "p/org1/ingest/files/d2/content.md", updatedAt: new Date("2026-11-01") },
  );
  s3.set("p/org1/ingest/files/d1/content.md", session(24));
  s3.set("p/org1/ingest/files/d2/content.md", "# Pricing guide\n\nOff-plan payment plans explained.");

  const files = await pullKnowledgeBase(kb, kbFetch);
  expect(knowledgeWhere).toEqual({ kb: { orgId: "org1" }, s3MarkdownKey: { not: null }, status: { not: "failed" } });
  expect(files.map((f) => f.path)).toEqual(["data/uploads/Lesson 2: role play [d1].md", "data/uploads/Pricing 2026 guide [d2].md"]);

  // Synced once into users/<user>/, then told apart: two speakers = a recording, none = method material.
  const disk = new Map<string, string>();
  const io = {
    read: async (rel: string) => disk.get(rel) ?? null,
    write: async (rel: string, content: string) => void disk.set(rel, content),
    list: async () => [],
    grep: async () => [],
    sources: () => pullKnowledgeBase(kb, kbFetch),
  };
  const inventory = await ensureSynced(io, "olga");
  expect(disk.get("users/olga/data/uploads/Pricing 2026 guide [d2].md")).toContain("Off-plan payment plans");
  expect(inventory.map((f) => [f.id, f.kind, f.candidate ?? false])).toEqual([["d1", "media", true], ["d2", "doc", false]]);
});

test("knowledge sources: secret and org required; a failed download fails the pull", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  expect((await knowledgeSources(new Request("https://dash.test/api/internal/knowledge-sources", { headers: { authorization: "Bearer wrong", "x-trainertwin-org-id": "org1" } }))).status).toBe(401);
  expect((await knowledgeSources(new Request("https://dash.test/api/internal/knowledge-sources", { headers: { authorization: `Bearer ${kb.secret}` } }))).status).toBe(400);
  knowledgeDocs.splice(0, knowledgeDocs.length, { id: "d9", title: "Gone", s3MarkdownKey: "p/org1/ingest/files/d9/content.md", updatedAt: new Date("2026-11-01") });
  await expect(pullKnowledgeBase(kb, kbFetch)).rejects.toThrow('could not download "Gone"');
});

test("only studio (organization) sessions read the knowledge base, and never fall back to the users folder", () => {
  const org = { principalId: "org1", principalType: "organization" };
  expect(knowledgeBaseFor(org, { STUDIO_URL: "https://dash.test", SCENARIO_INGEST_SECRET: "s" })).toEqual({ url: "https://dash.test", secret: "s", orgId: "org1" });
  expect(knowledgeBaseFor(org, {})).toBe("unconfigured");
  expect(knowledgeBaseFor({ principalId: "me", principalType: "user" }, {})).toBeNull();
  expect(knowledgeBaseFor(null, {})).toBeNull();
});

// ---- twin-creator: the trainer's knowledge, decisions and approach on one topic (not a role play) ----
const { saveTwinSkill, prepareTwinPublication } = await import("../../../copilot/agent/lib/twin-skill");
const { publishTwinSkillToStudio } = await import("../../../copilot/agent/lib/studio-publish");
const { POST: twinSkills } = await import("@/app/api/internal/twin-skills/route");

const twinSources = [
  { path: "data/uploads/Coaching call [call0001].md", text: [
    "---\ntitle: Coaching call\n---",
    "speaker_1: When a buyer tells me they will wait for prices to drop, I ask what they are really waiting for.",
    "speaker_2: Okay so I should just ask them what they wait for then?",
    "speaker_1: If they talk about the market, I show them how payment plans spread the risk over years.",
    "speaker_1: I never chase a buyer who wants cashback, I explain what the developer gives instead.",
    "speaker_2: And what if they still insist on the cashback offer from the other agent?",
    "speaker_1: Then I tell them that a discount today often costs more in the payment plan later.",
  ].join("\n") },
  { path: "data/uploads/Lesson [lesson01].md", text: "speaker_1: Most buyers who wait are afraid of losing money, not of the price itself.\nspeaker_1: Cashback requests usually mean the buyer compares agents rather than properties." },
  { path: "data/uploads/Method [method01].md", text: "# Method\n\nPrices in off-plan projects rarely drop once the launch phase has sold out.\n\nA developer cashback is usually priced into the unit already, so it is rarely a real saving." },
];
const twinIo = () => {
  const disk = new Map<string, string>();
  return {
    disk,
    io: { read: async (p: string) => disk.get(p) ?? null, write: async (p: string, c: string) => void disk.set(p, c), list: async () => [], grep: async () => [], sources: async () => twinSources },
  };
};
const twinHead = { skill: "off-plan-waiting", name: "Buyers who wait for prices", description: "When an off-plan buyer wants to wait for prices to drop or asks for cashback.", situations: [{ id: "buyer-waits", name: "Buyer waits for prices" }, { id: "wants-cashback", name: "Buyer asks for cashback" }] };
const twinItems = [
  { source: "call0001", n: 0, situation: "buyer-waits", kind: "decision", context: "buyer says they will wait for prices" },
  { source: "call0001", n: 2, situation: "buyer-waits", kind: "decision", context: "buyer worries about the market" },
  { source: "call0001", n: 3, situation: "wants-cashback", kind: "decision", context: "buyer wants a cashback offer" },
  { source: "call0001", n: 5, situation: "wants-cashback", kind: "approach", context: "buyer insists on another agent's cashback" },
  { source: "lesson01", quote: "Most buyers who wait are afraid of losing money, not of the price itself.", situation: "buyer-waits", kind: "pattern", context: "why buyers wait" },
  { source: "lesson01", quote: "Cashback requests usually mean the buyer compares agents rather than properties.", situation: "wants-cashback", kind: "pattern", context: "what a cashback request means" },
  { source: "method01", quote: "Prices in off-plan projects rarely drop once the launch phase has sold out.", situation: "buyer-waits", kind: "knowledge", context: "how off-plan prices move" },
  { source: "method01", quote: "A developer cashback is usually priced into the unit already, so it is rarely a real saving.", situation: "wants-cashback", kind: "knowledge", context: "what a developer cashback is worth" },
];
const twinPatterns = `## What I know\n- Off-plan prices rarely drop after launch [[method01]]\n## How I decide\n- Ask what the buyer waits for [[call0001#0]]\n## Patterns I see\n- Waiting is fear of loss [[lesson01]]\n## My approach\n- Explain payment plans [[call0001#2]]\n## What I say\n- A discount today costs more later [[call0001#5]]\n## Gaps\n- Nothing on resale buyers\n`;
const twinBody = `## Topic
I handle two situations here: Buyer waits for prices, and Buyer asks for cashback.

## What I know
- Off-plan prices rarely drop once the launch phase has sold out.
- A developer cashback is usually priced into the unit already.

## How I decide
- When a buyer says they will wait, I ask what they are really waiting for, because the price is rarely the reason.
- If they talk about the market, I show how my payment plans spread the risk.
- When a buyer wants cashback, I explain what the developer gives instead, because chasing it makes me look desperate.

## Patterns I see
- My buyers who wait are usually afraid of losing money.

## My approach
I slow down, I ask, and I show the numbers of the plan.

## What I say
- "A discount today often costs more in the payment plan later."

## Gaps
- My material says nothing about resale buyers.
`;

test("twin-creator: builds a twin skill from the trainer's own words, and publishes it as a TWIN skill", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const { io } = twinIo();
  const saved = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: twinBody });
  expect(saved.saved).toBe(true);
  expect((saved as { check: { reasons: string[] } }).check.reasons).toEqual([]);
  expect((saved as { check: { pass: boolean; sources: number } }).check).toMatchObject({ pass: true, sources: 3 });

  const { files, rejected } = await prepareTwinPublication(io, "olga", "off-plan-waiting");
  expect(rejected).toEqual([]);
  agents.length = 0;
  const fetcher = async (url: string, init: RequestInit) => twinSkills(new Request(url, init));
  const result = await publishTwinSkillToStudio({ url: "https://dash.test", secret: "s3cret", orgId: "org1", persona: "vasanth", runId: "run-twin" }, "off-plan-waiting", files, fetcher);
  expect(result).toMatchObject({ ok: true, slug: "acme-off-plan-waiting", created: true, items: 8 });
  const agent = agents[0];
  expect(agent).toMatchObject({ kind: "TWIN", personaId: "p1", slug: "acme-off-plan-waiting" });
  const data = agent.data as Row;
  expect(data.source).toBe("twin-creator");
  expect((data.scenario as Row).situations).toEqual(twinHead.situations);
  expect(data.stages).toEqual([{ id: "buyer-waits", name: "Buyer waits for prices", objective: "Buyer waits for prices" }, { id: "wants-cashback", name: "Buyer asks for cashback", objective: "Buyer asks for cashback" }]);
  const artifacts = (agent.data as { artifacts: string }).artifacts;
  const managedSkill = skills.find(entry => entry.id === agent.primarySkillId)!;
  expect(artifacts.startsWith(`${realS3.orgPrefix("org1")}/skills/${managedSkill.id}/v1/attempt-`)).toBe(true);
  expect(artifacts).toMatch(/\/attempt-[0-9a-f-]{36}$/);
  for (const name of ["SKILL.md", "skill.json", "items.json", "patterns.md"]) {
    expect(s3.get(`${artifacts}/${name}`)).toBe(files.find(file => file.path.endsWith(`/${name}`))!.text);
  }
  expect(chroma).toEqual({ agentSlug: "acme-off-plan-waiting", count: 8 });
});

test("twin-creator: never the learner's words, never role-play structure, always first person", async () => {
  const { io } = twinIo();
  const learnerTurn = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: [...twinItems, { source: "call0001", n: 1, situation: "buyer-waits", kind: "approach", context: "the agent asks" }] as never, patterns: twinPatterns, body: twinBody });
  expect(learnerTurn.saved).toBe(false);
  expect(JSON.stringify(learnerTurn)).toContain("not the trainer");

  const noLabels = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: {}, names: [], items: twinItems as never, patterns: twinPatterns, body: twinBody });
  expect(JSON.stringify(noLabels)).toContain("list the trainer's labels");

  const rolePlayish = twinBody.replace("## Gaps", "## Playing the learner side\n- The learner pushes back.\n\n## Gaps").replaceAll(/\b(I|my|me)\b/g, "the trainer");
  const bad = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: rolePlayish });
  const reasons = (bad as { check: { pass: boolean; reasons: string[] } }).check;
  expect(reasons.pass).toBe(false);
  expect(reasons.reasons.join("\n")).toContain("role-play structure");
  expect(reasons.reasons.join("\n")).toContain("first person");
  const { files } = await prepareTwinPublication(io, "olga", "off-plan-waiting");
  expect(files).toEqual([]); // a failing skill is never published
});

test("twin-creator: a decision rule counts one per line, as a bullet, a numbered line or a plain paragraph", async () => {
  // A fresh sandbox per build: a session allows only 3 builds of one skill.
  const rules = ["When a buyer says they will wait, I ask what they wait for, because the price is rarely the reason.", "If they talk about the market, I show how my payment plans spread the risk.", "When a buyer wants cashback, I explain what the developer gives instead, because chasing it makes me look desperate."];
  for (const format of [(r: string) => `- ${r}`, (r: string, i: number) => `${i + 1}. ${r}`, (r: string) => `${r}\n`]) {
    const body = twinBody.replace(/## How I decide\n[\s\S]*?\n## Patterns I see/, `## How I decide\n${rules.map(format).join("\n")}\n\n## Patterns I see`);
    const saved = await saveTwinSkill(twinIo().io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body });
    expect((saved as { check: { reasons: string[] } }).check.reasons).toEqual([]);
  }
  const twoRules = twinBody.replace(/## How I decide\n[\s\S]*?\n## Patterns I see/, `## How I decide\n${rules.slice(0, 2).join("\n\n")}\n\n## Patterns I see`);
  const short = await saveTwinSkill(twinIo().io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: twoRules });
  expect((short as { check: { reasons: string[] } }).check.reasons.join("\n")).toContain('"## How I decide" has 2 rules');
});

test("twin-creator: start/end match the turn ignoring case and punctuation; the stored text is still the source's", async () => {
  const { io } = twinIo();
  // Turn 0: "When a buyer tells me they will wait for prices to drop, I ask what they are really waiting for."
  const part = { source: "call0001", n: 0, start: "i ASK what they", end: "really waiting", situation: "buyer-waits", kind: "decision", context: "what to ask a waiting buyer" };
  const saved = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: [...twinItems.slice(1), part] as never, patterns: twinPatterns, body: twinBody });
  expect((saved as { check: { reasons: string[] } }).check.reasons).toEqual([]);
  const items = JSON.parse(io ? (await io.read("output/olga/twin-skills/off-plan-waiting/items.json"))! : "[]") as { text: string }[];
  // From "i ASK what they" to "really waiting", with the turn's own casing and punctuation.
  expect(items.map((x) => x.text)).toContain("I ask what they are really waiting");
  const missing = await saveTwinSkill(twinIo().io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: [...twinItems, { ...part, start: "words that were never said" }] as never, patterns: twinPatterns, body: twinBody });
  expect(JSON.stringify(missing)).toContain("start is not in this turn");
});

test("twin-creator: Topic names a situation by its key words; a missing one is still reported", async () => {
  const paraphrase = twinBody.replace("I handle two situations here: Buyer waits for prices, and Buyer asks for cashback.", "Two cases: a buyer who waits for lower prices, and a buyer who asks me about cashback.");
  const ok = await saveTwinSkill(twinIo().io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: paraphrase });
  expect((ok as { check: { reasons: string[] } }).check.reasons).toEqual([]);
  const gone = twinBody.replace("I handle two situations here: Buyer waits for prices, and Buyer asks for cashback.", "I handle the buyer who waits for prices.");
  const bad = await saveTwinSkill(twinIo().io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: gone });
  expect((bad as { check: { reasons: string[] } }).check.reasons).toEqual(['"## Topic" should name the situation "Buyer asks for cashback"']);
});

test("twin-creator: a 4th build of the same skill is refused, so the copilot reports and stops instead of looping", async () => {
  const { io } = twinIo();
  const build = () => saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: twinBody });
  for (let i = 0; i < 3; i++) expect((await build()).saved).toBe(true);
  const fourth = await build();
  expect(fourth).toMatchObject({ saved: false, stop: true });
  expect(JSON.stringify(fourth)).toContain("the limit is 3");
});

test("twin skills endpoint: secret, org, and the trainer's words only", async () => {
  process.env.SCENARIO_INGEST_SECRET = "s3cret";
  const post = (body: unknown, headers: Record<string, string> = { authorization: "Bearer s3cret", "x-trainertwin-org-id": "org1" }) =>
    twinSkills(new Request("https://dash.test/api/internal/twin-skills", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  expect((await post({}, { authorization: "Bearer wrong", "x-trainertwin-org-id": "org1" })).status).toBe(401);
  expect((await post({}, { authorization: "Bearer s3cret" })).status).toBe(400);
  const learnerItem = { id: "x", role: "learner", context: "c", text: "the learner says something here", metadata: {} };
  expect((await post({ personaSlug: "vasanth", skill: "---\n---\n", manifest: twinHead, items: [learnerItem] })).status).toBe(400);
});
