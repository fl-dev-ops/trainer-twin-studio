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
  expect([...s3.keys()].some((k) => k.endsWith("acme-off-plan-waiting/v1/skill.json"))).toBe(true);
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
  const { io } = twinIo();
  const rules = ["When a buyer says they will wait, I ask what they wait for, because the price is rarely the reason.", "If they talk about the market, I show how my payment plans spread the risk.", "When a buyer wants cashback, I explain what the developer gives instead, because chasing it makes me look desperate."];
  for (const format of [(r: string) => `- ${r}`, (r: string, i: number) => `${i + 1}. ${r}`, (r: string) => `${r}\n`]) {
    const body = twinBody.replace(/## How I decide\n[\s\S]*?\n## Patterns I see/, `## How I decide\n${rules.map(format).join("\n")}\n\n## Patterns I see`);
    const saved = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body });
    expect((saved as { check: { reasons: string[] } }).check.reasons).toEqual([]);
  }
  const twoRules = twinBody.replace(/## How I decide\n[\s\S]*?\n## Patterns I see/, `## How I decide\n${rules.slice(0, 2).join("\n\n")}\n\n## Patterns I see`);
  const short = await saveTwinSkill(io, "olga", { user: "olga", skill: twinHead, trainer: { call0001: ["speaker_1"] }, names: [], items: twinItems as never, patterns: twinPatterns, body: twoRules });
  expect((short as { check: { reasons: string[] } }).check.reasons.join("\n")).toContain('"## How I decide" has 2 rules');
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
