import { expect, mock, test } from "bun:test";

// Contract: the copilot (scenario-ingest agent) publisher against the real web routes.
// Postgres, S3 and Chroma are faked; everything between them is the production code of both services.
type Row = Record<string, unknown>;
const agents: Row[] = [];
const s3 = new Map<string, string>();
let chroma: { agentSlug: string; count: number } | null = null;
let knowledgeWhere: Row | null = null;
const knowledgeDocs: { id: string; title: string; s3MarkdownKey: string }[] = [];

const fakeDb = {
  organization: { findUnique: async () => ({ id: "org1", slug: "acme" }) },
  persona: {
    findFirst: async ({ where }: { where: { slug: { equals: string } } }) => (where.slug.equals.toLowerCase() === "vasanth" ? { id: "p1" } : null),
  },
  agent: {
    findUnique: async ({ where }: { where: { slug: string } }) => agents.find((a) => a.slug === where.slug) ?? null,
    create: async ({ data }: { data: Row }) => void agents.push({ id: "a1", ...data }),
    update: async () => {},
  },
  domain: { findUnique: async () => null, create: async () => {} },
  specVersion: { create: async () => {} },
  knowledgeDocument: {
    findMany: async (args: { where: Row }) => {
      knowledgeWhere = args.where;
      return knowledgeDocs;
    },
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};
mock.module("@/lib/db", () => ({ db: fakeDb }));
mock.module("@/lib/s3", () => ({
  s3Configured: true,
  scenarioArtifactsPrefix: (orgId: string, slug: string, version: number) => `p/${orgId}/scenarios/${slug}/v${version}`,
  scenarioRunPrefix: (orgId: string, runId: string) => `p/${orgId}/runs/${runId}`,
  putObject: async (key: string, body: string) => void s3.set(key, body),
  deletePrefix: async () => {},
  getObjectText: async () => "",
  kbPrefix: () => "",
  presignedGetUrl: async (key: string) => `https://s3.test/${key}`,
}));
mock.module("@/lib/main-collection", () => ({
  invalidateCollectionCache: () => {},
  invalidatePersonaStyleCache: () => {},
  MainCollectionService: {
    replaceScenarioItems: async (_org: string, agentSlug: string, _id: string, items: unknown[]) => {
      chroma = { agentSlug, count: items.length };
      return items.length;
    },
  },
}));

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

  const v1 = "p/org1/scenarios/acme-fundamental-depth/v1";
  for (const [name, path] of [["SKILL.md", "fundamental-depth/SKILL.md"], ["scenario.json", "fundamental-depth/scenario.json"], ["items.json", "fundamental-depth/items.json"], ["patterns.md", "fundamental-depth/patterns.md"]]) {
    expect(s3.get(`${v1}/${name}`)).toBe(files.find((f) => f.path === path)!.text);
  }
  expect(s3.get("p/org1/runs/sess-01-abc/plan.json")).toBe(files.find((f) => f.path === "plan.json")!.text);
  expect(s3.get("p/org1/runs/sess-01-abc/report.md")).toBe("# Report\n");
  expect(s3.get("p/org1/runs/sess-01-abc/specs/fundamental-depth.md")).toBe("# Spec\n");
  expect(chroma).toEqual({ agentSlug: "acme-fundamental-depth", count: 1 });
  // The copilot's roleplay-creator publishes role plays, never twin skills.
  expect(agents[0]).toMatchObject({ slug: "acme-fundamental-depth", personaId: "p1", orgId: "org1", kind: "ROLEPLAY" });
  expect((agents[0].data as Row).skill).toBe(skill);
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
    { id: "d1", title: "Lesson 2: role play", s3MarkdownKey: "p/org1/ingest/files/d1/content.md" },
    { id: "d2", title: "Pricing [2026] / guide", s3MarkdownKey: "p/org1/ingest/files/d2/content.md" },
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
  knowledgeDocs.splice(0, knowledgeDocs.length, { id: "d9", title: "Gone", s3MarkdownKey: "p/org1/ingest/files/d9/content.md" });
  await expect(pullKnowledgeBase(kb, kbFetch)).rejects.toThrow('could not download "Gone"');
});

test("only studio (organization) sessions read the knowledge base, and never fall back to the users folder", () => {
  const org = { principalId: "org1", principalType: "organization" };
  expect(knowledgeBaseFor(org, { STUDIO_URL: "https://dash.test", SCENARIO_INGEST_SECRET: "s" })).toEqual({ url: "https://dash.test", secret: "s", orgId: "org1" });
  expect(knowledgeBaseFor(org, {})).toBe("unconfigured");
  expect(knowledgeBaseFor({ principalId: "me", principalType: "user" }, {})).toBeNull();
  expect(knowledgeBaseFor(null, {})).toBeNull();
});
