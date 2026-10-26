import { expect, mock, test } from "bun:test";

// Contract: the copilot (scenario-ingest agent) publisher against the real web routes.
// Postgres, S3 and Chroma are faked; everything between them is the production code of both services.
type Row = Record<string, unknown>;
const agents: Row[] = [];
const s3 = new Map<string, string>();
let chroma: { agentSlug: string; count: number } | null = null;

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
  presignedGetUrl: async () => "",
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
  expect(agents[0]).toMatchObject({ slug: "acme-fundamental-depth", personaId: "p1", orgId: "org1" });
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
