import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { updateRoleplay } from "@/lib/roleplay/manage";
import { loadRoleplayReportInput } from "@/lib/roleplay/session-report";
import { twinRouter } from "@/lib/twin/trpc";
import { buildSessionContext } from "@/lib/session-context";
import { hydrateAgentSkill } from "@/lib/skill-history";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { RoleplayBuilder } from "@/lib/roleplay/skill";
import { db, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";
const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3, s3Configured: true,
  putObject: async (key: string, body: string) => { files.set(key, body); },
  getObjectText: async (key: string) => {
    const body = files.get(key);
    if (body === undefined) throw new Error(`Missing test object: ${key}`);
    return body;
  },
}));
const { saveRoleplay, ingestScenario } = await import("@/lib/scenario-ingest");
const { POST } = await import("@/app/api/copilot/studio/route");

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase)("Phase 5 package-free readers (real Postgres)", () => {
  let f: MinutesFixture;
  let secret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    files.clear();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "package-free-readers-test";
    spies.push(
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _id, _scenario, items) => items.length),
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _id, _scenario, _version, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
    );
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.skillVersionSource.deleteMany({ where: { orgId: f.org.id } });
    await db.skillSource.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });
  const ctx = () => ({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const builder = (): RoleplayBuilder => ({
    name: "Package-free practice", persona: f.org.slug, clientName: "Pinned buyer",
    situation: { scenario: "Buyer is uncertain", learnerRole: "Advisor" },
    difficulty: "medium", opening: "I need more time", exampleLines: ["Please explain"],
    guardedIf: [], opensUpIf: [], learnerGoals: ["Understand the concern"],
    rubric: [{ name: "Understanding", points: 100 }],
  });
  const stripPackage = async (slug: string) => {
    const agent = await db.agent.findUniqueOrThrow({ where: { slug } });
    const data = agent.data && typeof agent.data === "object" && !Array.isArray(agent.data) ? agent.data : {};
    const settings = Object.fromEntries(Object.entries(data).filter(([key]) => !["skill", "scenario", "artifacts", "filesHash"].includes(key)));
    return db.agent.update({ where: { slug }, data: { data: settings as Prisma.InputJsonObject } });
  };
  const search = (agentSlug: string) => POST(new Request("http://localhost/api/copilot/studio", {
    method: "POST", headers: { authorization: "Bearer package-free-readers-test", "x-trainertwin-org-id": f.org.id, "content-type": "application/json" },
    body: JSON.stringify({ action: "searchScenarioItems", agentSlug, query: "uncertain buyer" }),
  }));

  test("builder, cards, detail and copilot edits read mapped packages without restoring row copies", async () => {
    const saved = await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    await stripPackage(saved.slug);
    const caller = roleplayRouter.createCaller(ctx());
    expect((await buildSessionContext({ orgId: f.org.id, agentSlug: saved.slug, personaSlug: f.org.slug })).agent?.data).toMatchObject({
      scenario: { roleplay: { opening: "I need more time" } },
    });
    expect((await caller.builder.get({ slug: saved.slug })).builder).toMatchObject({ opening: "I need more time" });
    expect((await caller.scenarios.list()).find((row) => row.slug === saved.slug)).toMatchObject({
      opening: "I need more time", client: { name: "Pinned buyer" },
    });
    expect(await caller.scenarios.get({ slug: saved.slug })).toMatchObject({ situation: "Buyer is uncertain", learnerRole: "Advisor" });
    await updateRoleplay(f.org.id, saved.slug, { builder: { opening: "Ask me tomorrow" } });
    await stripPackage(saved.slug);
    const editor = await caller.builder.get({ slug: saved.slug });
    expect(editor.builder?.opening).toBe("Ask me tomorrow");
    if (!editor.builder) throw new Error("Mapped package did not restore builder fields");
    await caller.builder.save({ slug: saved.slug, builder: { ...editor.builder, opening: "Call next week" }, before: editor.before, tools: editor.tools });
    await stripPackage(saved.slug);
    expect((await caller.builder.get({ slug: saved.slug })).builder?.opening).toBe("Call next week");
    expect((await db.agent.findUniqueOrThrow({ where: { slug: saved.slug } })).data).not.toHaveProperty("scenario");
  });

  test("authored settings edits remain package-free", async () => {
    const saved = await ingestScenario(f.org.id, {
      kind: "ROLEPLAY", personaSlug: f.org.slug, skill: "# Authored buyer",
      scenario: { scenario: "authored-buyer", name: "Authored buyer", description: "Buyer", trainer_role: "Buyer", learner_role: "Advisor", steps: [] }, items: [],
    });
    await stripPackage(saved.slug);
    await updateRoleplay(f.org.id, saved.slug, { before: { preUpload: true } });
    const agent = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug } });
    expect(agent.data).toMatchObject({ before: { preUpload: true } });
    expect(agent.data).not.toHaveProperty("skill");
    expect(agent.data).not.toHaveProperty("scenario");
  });

  test("twin detail and live context hydrate current mapped manifests", async () => {
    const saved = await ingestScenario(f.org.id, {
      kind: "TWIN", personaSlug: f.org.slug, skill: "# Help an uncertain buyer",
      scenario: { scenario: "package-free-twin", name: "Package-free twin", description: "Buyer coaching", trainer_role: "Coach", learner_role: "Advisor", steps: [] },
      items: [],
    });
    await stripPackage(saved.slug);
    expect(await twinRouter.createCaller(ctx()).agents.get({ slug: saved.slug })).toMatchObject({ whoAsks: "Advisor" });
    expect((await twinRouter.createCaller(ctx()).agents.list()).skills.some((row) => row.slug === saved.slug)).toBe(true);
    const context = await buildSessionContext({ orgId: f.org.id, agentSlug: saved.slug, personaSlug: f.org.slug });
    expect(context.agent?.data).toMatchObject({ skill: "# Help an uncertain buyer", scenario: { learner_role: "Advisor" } });
  });

  test("single and main previews search only exact managed scopes, including empty main catalogs", async () => {
    const saved = await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    await stripPackage(saved.slug);
    const managed = spyOn(MainCollectionService, "searchSkillItems").mockResolvedValue([]);
    const legacy = spyOn(MainCollectionService, "searchScenarioItems").mockRejectedValue(new Error("Managed preview must not use legacy search"));
    spies.push(managed, legacy);
    expect((await search(saved.slug)).status).toBe(200);
    expect(managed.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ skillVersionId: expect.any(String), indexScope: saved.artifacts })]);
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin", objective: "Coach" } } });
    expect((await search(f.twin.slug)).status).toBe(200);
    expect(managed).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    const twin = await ingestScenario(f.org.id, {
      kind: "TWIN", personaSlug: f.org.slug, skill: "# Buyer coaching",
      scenario: { scenario: "preview-twin", name: "Preview twin", description: "Coaching", trainer_role: "Coach", learner_role: "Advisor", steps: [] }, items: [],
    });
    await stripPackage(twin.slug);
    expect((await search(f.twin.slug)).status).toBe(200);
    expect(managed.mock.calls[1]?.[1]).toEqual([expect.objectContaining({ indexScope: twin.artifacts })]);
    expect(legacy).not.toHaveBeenCalled();
  });

  test("saved session client and report instructions stay frozen after current package removal and edits", async () => {
    const saved = await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const agent = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug }, include: { persona: true } });
    const hydrated = await hydrateAgentSkill(f.org.id, agent);
    const mapping = await db.agentSkillVersion.findUniqueOrThrow({ where: { agentId_agentVersion: { agentId: agent.id, agentVersion: agent.version } } });
    const session = await f.session({
      agentVersion: agent.version, skillPinsVersion: 1,
      compiledSnapshot: JSON.parse(JSON.stringify({ agent: { ...agent, data: hydrated.data }, persona: agent.persona })),
      skillPins: { create: { alias: agent.slug, position: 0, skillVersionId: mapping.skillVersionId } },
      transcript: [{ role: "user", text: "What concerns you?" }],
    });
    await stripPackage(saved.slug);
    await db.agent.update({ where: { slug: saved.slug }, data: { name: "Changed experience", data: { source: "roleplay-skill", after: { report: "roleplay", goals: ["Changed goal"] } } } });
    const input = await loadRoleplayReportInput(session.id);
    expect(input.agentName).toBe("Package-free practice");
    expect(input.brief).toContain("I need more time");
    expect(input.goals).toEqual(["Understand the concern"]);
    expect((await roleplayRouter.createCaller(ctx()).sessions.get({ id: session.id })).client.name).toBe("Pinned buyer");
  });
});
