import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as ending from "@/lib/session-end";
import { MainCollectionService } from "@/lib/main-collection";
import { activateSession } from "@/lib/interview-sessions";
import { buildSessionContext } from "@/lib/session-context";
import { briefFixtures } from "../fixtures/roleplay-briefs";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3, s3Configured: true,
  putObject: async (key: string, body: string) => { files.set(key, body); },
  getObjectText: async (key: string) => {
    const bytes = files.get(key);
    if (bytes === undefined) throw new Error(`Missing test object ${key}`);
    return bytes;
  },
}));
const { runCopilotStudio } = await import("@/lib/copilot-studio");
const { roleplayRouter } = await import("@/lib/roleplay/trpc");
const { listAgentBriefs } = await import("@/lib/specs");

describe.skipIf(!localMinutesDb)("role plays written from requirements, through the copilot's studio actions (real Postgres)", () => {
  let f: MinutesFixture;
  let secret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  const written: unknown[][] = [];
  const actor = () => ({ org: f.org, user: { id: f.trainer.id, name: f.trainer.name } });
  const studio = (input: Parameters<typeof runCopilotStudio>[1]) => runCopilotStudio(actor(), input);
  const brief = (name: keyof typeof briefFixtures) => structuredClone(briefFixtures[name].brief);

  beforeEach(async () => {
    f = minutesFixture();
    await f.create({ voice: true });
    files.clear(); written.length = 0;
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "roleplay-brief-test";
    const fetch = globalThis.fetch;
    spies.push(
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_o, _s, _c, _v, items) => items.length),
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_o, _i, _c, items) => { written.push(items); return items.length; }),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
      spyOn(ending, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("meteroid.test")) return fetch(url, init);
        if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    await db.persona.create({ data: { orgId: f.org.id, slug: "chloe", name: "Chloe Martin", data: { id: "chloe", name: "Chloe Martin", role: "Operations lead", background: "Defensive and quick to explain." } } });
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.skillVersionSource.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  test("lists personas, drafts without saving, publishes once, republishes as a no-op and an edit as v2", async () => {
    const { personas } = await studio({ action: "listPersonas" }) as { personas: { slug: string; role: string | null }[] };
    expect(personas.map((p) => p.slug)).toEqual([f.org.slug, "chloe"]);
    expect(personas[1]).toMatchObject({ role: "Operations lead", usedBy: 0 });

    const draft = await studio({ action: "draftRoleplay", brief: brief("bevan-missed-deadlines") }) as Record<string, unknown>;
    expect(draft).toMatchObject({ ok: true, slug: `${f.org.slug}-bevan-missed-deadlines-chloe`, items: 0 });
    expect(String(draft.skill)).toContain("## How you react");
    expect(await db.agent.count({ where: { slug: String(draft.slug) } })).toBe(0); // a draft saves nothing

    const first = await studio({ action: "publishRoleplay", persona: "chloe", brief: brief("bevan-missed-deadlines") });
    expect(first).toMatchObject({ ok: true, slug: draft.slug, created: true });
    const again = await studio({ action: "publishRoleplay", persona: "chloe", brief: brief("bevan-missed-deadlines") });
    expect(again).toMatchObject({ created: false, version: (first as { version: number }).version });

    const edited = brief("bevan-missed-deadlines");
    edited.ending.limit = "At most 5 minutes.";
    await studio({ action: "publishRoleplay", persona: "chloe", brief: edited });
    const agent = await db.agent.findUniqueOrThrow({ where: { slug: String(draft.slug) }, include: { primarySkill: { include: { currentVersion: true } }, persona: true } });
    expect(agent.persona.slug).toBe("chloe");
    expect(agent.primarySkill?.currentVersion).toMatchObject({ version: 2, format: "authored-roleplay", status: "ready" });
    expect(agent.primarySkill?.currentVersion?.skillText).toContain("- At most 5 minutes.");

    const read = await studio({ action: "get", slug: agent.slug, kind: "roleplay" }) as Record<string, unknown>;
    expect(read).toMatchObject({ kind: "roleplay-brief", brief: { id: "bevan-missed-deadlines-chloe", ending: { limit: "At most 5 minutes." } } });
    expect((await studio({ action: "list", kind: "roleplay" }) as { items: { slug: string; kind: string }[] }).items)
      .toContainEqual(expect.objectContaining({ slug: agent.slug, kind: "roleplay-brief" }));
  });

  test("items are indexed with their kind, step and tags", async () => {
    await db.persona.create({ data: { orgId: f.org.id, slug: "linda", name: "Linda Chen", data: { role: "Supply planning manager" } } });
    await studio({ action: "publishRoleplay", persona: "linda", brief: brief("jameel-technical-round") });
    expect(written.at(-1)).toEqual([
      expect.objectContaining({ text: "How do you decide how much to order and when?", metadata: { step: "question-1", kind: "question", source: "authored", tags: ["technical"] } }),
      expect.anything(), expect.anything(),
    ]);
  });

  test("a session on it runs the brief as the AI's skill with the persona, and the learner brief is the description", async () => {
    const { slug } = await studio({ action: "publishRoleplay", persona: "chloe", brief: brief("bevan-missed-deadlines") }) as { slug: string };
    const session = await activateSession({ orgId: f.org.id, userId: f.trainer.id, agentSlug: slug, mode: "chat", idempotencyKey: crypto.randomUUID() });
    if (!session) throw new Error("Expected a session");
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, include: { skillPins: true } });
    expect(row.skillPinsVersion).toBe(1);
    const context = await buildSessionContext({ orgId: f.org.id, sessionId: session.id });
    const data = context.agent?.data as Record<string, unknown>;
    expect(data.source).toBe("scenario-ingest");
    expect(String(data.skill)).toContain('You speak first: "Is this about the release? Because there\'s a reason for that."');
    expect(data.scenario).toMatchObject({ trainer_role: "Employee", learner_role: "Founder", description: briefFixtures["bevan-missed-deadlines"].brief.learnerBrief });
    expect(context.persona).toMatchObject({ slug: "chloe" });
    expect(context.personaBrief).toContain("- Who: Chloe Martin, Operations lead.");
  });

  test("the role-play pages read a copilot-written role play: library, detail, edit; core fields save as a new version", async () => {
    const { slug } = await studio({ action: "publishRoleplay", persona: "chloe", brief: brief("bevan-missed-deadlines") }) as { slug: string; version: number };
    const caller = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } } as never);
    const fixture = briefFixtures["bevan-missed-deadlines"].brief;

    const card = (await caller.scenarios.list()).find((row) => row.slug === slug);
    expect(card).toMatchObject({ href: `/roleplay/${slug}`, description: fixture.learnerBrief, opening: fixture.start.openingLine });

    const detail = await caller.scenarios.get({ slug });
    expect(detail).toMatchObject({ situation: fixture.summary, learnerRole: fixture.learner.role, description: fixture.learnerBrief });
    expect(detail.script).toMatchObject({ aiRole: fixture.ai.role, steps: fixture.steps.map((step) => ({ name: step.name, what: step.what })) });

    const edit = await caller.builder.get({ slug });
    expect(edit.builder).toBeNull();
    expect(edit.brief).toMatchObject({ persona: "chloe", title: fixture.title, openingLine: fixture.start.openingLine, aiStarts: true });

    const unchanged = await caller.builder.saveBrief({ slug, persona: "chloe", title: fixture.title, learnerBrief: fixture.learnerBrief, openingLine: fixture.start.openingLine!, limit: fixture.ending.limit ?? "" });
    expect(unchanged.changed).toBe(false);
    const saved = await caller.builder.saveBrief({ slug, persona: "chloe", title: "Missed deadlines, take two", learnerBrief: "You are the founder. Find out why the release slipped.", openingLine: "You wanted to see me?", limit: "At most 3 minutes." });
    expect(saved).toMatchObject({ slug, changed: true });
    const after = await caller.builder.get({ slug });
    expect(after.brief).toMatchObject({ title: "Missed deadlines, take two", openingLine: "You wanted to see me?", limit: "At most 3 minutes." });
    // The rest of the script is untouched, and the session runs the re-rendered skill.
    expect(after.brief?.script.steps).toEqual(detail.script!.steps);
    const agent = await db.agent.findUniqueOrThrow({ where: { slug }, include: { primarySkill: { include: { currentVersion: true } } } });
    expect(agent.name).toBe("Missed deadlines, take two");
    expect(agent.primarySkill?.currentVersion?.skillText).toContain('"You wanted to see me?"');
    expect(await listAgentBriefs(f.org.id, [slug])).toEqual({ [slug]: "You are the founder. Find out why the release slipped." });

    await expect(caller.builder.saveBrief({ slug, persona: "nobody", title: "x", learnerBrief: "x", openingLine: "x", limit: "At most 3 minutes." })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The brief's own checks still apply: clearing the only ending is refused with the reason.
    await expect(caller.builder.saveBrief({ slug, persona: "chloe", title: "x", learnerBrief: "x", openingLine: "x", limit: "" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Say when the conversation ends") });
  });

  test("a role play made in the older form opens the same simple edit page and saves its basics", async () => {
    const { saveRoleplay } = await import("@/lib/scenario-ingest");
    const made = await saveRoleplay(f.org.id, {
      name: "Older practice", persona: "chloe", clientName: "Pinned buyer",
      situation: { scenario: "Buyer is uncertain", learnerRole: "Advisor", hiddenTruth: "Worried about the mortgage" },
      difficulty: "medium", opening: "I need more time", whatToExpect: "Find out why they are unsure.", exampleLines: ["Please explain"],
      guardedIf: [], opensUpIf: [], learnerGoals: ["Understand the concern"], rubric: [{ name: "Understanding", points: 100 }],
    });
    const caller = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } } as never);
    const edit = await caller.builder.get({ slug: made.slug });
    expect(edit.brief).toMatchObject({ kind: "builder", persona: "chloe", title: "Older practice", learnerBrief: "Find out why they are unsure.", openingLine: "I need more time" });
    expect(edit.brief?.script).toMatchObject({ learnerRole: "Advisor", situation: ["Buyer is uncertain"], concerns: [{ concern: "Worried about the mortgage", hidden: true }] });
    expect((await caller.scenarios.get({ slug: made.slug })).script).toMatchObject({ learnerRole: "Advisor" });

    const saved = await caller.builder.saveBrief({ slug: made.slug, persona: "chloe", title: "Older practice, renamed", learnerBrief: "Find the real worry.", openingLine: "Not sure yet.", limit: "" });
    expect(saved.changed).toBe(true);
    const after = await caller.builder.get({ slug: made.slug });
    // Basics changed; the rest of the form's fields kept (rubric, difficulty, example lines).
    expect(after.builder).toMatchObject({ name: "Older practice, renamed", whatToExpect: "Find the real worry.", opening: "Not sure yet.", difficulty: "medium", exampleLines: ["Please explain"], rubric: [{ name: "Understanding", points: 100 }] });
  });

  test("refuses an incomplete brief, an unknown persona and an id another role play already owns", async () => {
    const incomplete = brief("bevan-missed-deadlines");
    delete incomplete.start.openingLine;
    await expect(studio({ action: "publishRoleplay", persona: "chloe", brief: incomplete })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("add its opening line") });
    await expect(studio({ action: "publishRoleplay", persona: "nobody", brief: brief("bevan-missed-deadlines") })).rejects.toMatchObject({ status: 404 });
    await db.agent.create({ data: { slug: `${f.org.slug}-taken`, name: "Taken", kind: "ROLEPLAY", orgId: f.org.id, personaId: (await db.persona.findFirstOrThrow({ where: { orgId: f.org.id, slug: "chloe" } })).id, data: { skill: "# other", source: "scenario-ingest" } } });
    await expect(studio({ action: "publishRoleplay", persona: "chloe", brief: { ...brief("bevan-missed-deadlines"), id: "taken" } })).rejects.toMatchObject({ status: 409 });
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
