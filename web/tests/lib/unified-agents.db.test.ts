import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as workflow from "workflow/api";
import * as livekit from "@/lib/livekit";
import { supportingCatalog, setSupportingSkills } from "@/lib/agent-skills";
import { pickSessionPersona, setAgentPersonas } from "@/lib/agent-personas";
import { createBot, saveBotPublic, saveBotSkills } from "@/lib/bots";
import { getAgentConfigForAgent } from "@/lib/specs";
import { resolveTwinCatalog } from "@/lib/twins";
import { startPublicTwinSession } from "@/lib/public-twin-sessions";
import { skillPackageHash } from "@/lib/skills";
import { orgPrefix } from "@/lib/s3";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

/** Twins, role plays and bots share one shape (specs/agents.md): main skill, supporting skills, persona(s). */
describe.skipIf(!localMinutesDb)("unified agents: supporting skills and personas (real database)", () => {
  let f: MinutesFixture;
  let persona: { id: string; slug: string };
  const spies: { mockRestore(): void }[] = [];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");

  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    persona = await db.persona.findFirstOrThrow({ where: { orgId: f.org.id, slug: f.org.slug }, select: { id: true, slug: true } });
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkill.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  /** A topic twin with a ready, published `twin` skill package (like Olga's objection handling). */
  async function topicSkill(name: string) {
    const slug = `${f.org.slug}-${name}`;
    await db.agent.create({ data: { orgId: f.org.id, slug, name, kind: "TWIN", personaId: persona.id, data: { source: "twin-creator" } } });
    const skill = await db.skill.create({ data: { orgId: f.org.id, ownerSlug: slug, name } });
    const files = { "SKILL.md": `# ${name}`, "skill.json": "{}", "items.json": "[]" };
    const version = await db.skillVersion.create({ data: {
      skillId: skill.id, version: 1, format: "twin", status: "ready", indexStatus: "ready",
      contentHash: skillPackageHash("twin", files), files, skillText: `# ${name}`, manifest: {}, itemCount: 0,
      artifacts: `${orgPrefix(f.org.id)}/skills/${slug}/v1`,
    } });
    await db.skill.update({ where: { id: skill.id }, data: { currentVersionId: version.id } });
    return { skill, version, slug };
  }

  test("a twin's catalog is its active supporting skills in order; inactive ones stay attached but unused", async () => {
    const silent = await topicSkill("silent");
    const objections = await topicSkill("objections");
    const extra = await topicSkill("extra");
    expect(await supportingCatalog(f.org.id, f.twin.id)).toBeNull();
    await db.$transaction((tx) => setSupportingSkills(f.org.id, f.twin.id, [
      { skillId: objections.skill.id, active: true }, { skillId: extra.skill.id, active: false }, { skillId: silent.skill.id, active: true },
    ], tx));
    const selected = await db.$transaction((tx) => resolveTwinCatalog(f.org.id, persona.id, tx, f.twin.id));
    expect(selected.catalog.map((entry) => entry.slug)).toEqual([objections.slug, silent.slug]);
    expect(selected.pins).toEqual([
      { skillVersionId: objections.version.id, alias: objections.slug, position: 0 },
      { skillVersionId: silent.version.id, alias: silent.slug, position: 1 },
    ]);
    expect(await db.agentSkill.count({ where: { agentId: f.twin.id } })).toBe(3);
  });

  test("a bot speaking as any persona pins its active supporting skills into each public call", async () => {
    const custom = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-guide`, name: "Guide", data: {} } });
    const objections = await topicSkill("objections");
    const bot = await db.$transaction(async (tx) => {
      const made = (await createBot(f.org.id, { personaId: custom.id, name: "Homepage", objective: "Welcome visitors." }, tx))!;
      const withSkills = (await saveBotSkills(made, [{ skillId: objections.skill.id, active: true }], tx))!;
      return (await saveBotPublic(withSkills, { publicAccess: { enabled: true } }, tx))!;
    });
    expect(bot).toMatchObject({ personaId: custom.id, data: { source: "bot", objective: "Welcome visitors." } });
    expect(bot.data).not.toHaveProperty("twinId");
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    spies.push(
      spyOn(workflow, "start").mockResolvedValue(undefined as never),
      spyOn(livekit, "activateLiveKitSession").mockImplementation(async (input) => ({
        room: input.sessionId, token: "token", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null,
      })),
      spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 })),
    );
    const opened = await startPublicTwinSession({ orgId: f.org.id, agentId: bot.id, visitorId: hash(randomUUID()), ipHash: hash(randomUUID()), name: "Visitor" });
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: opened.session.id }, include: { skillPins: true } });
    expect(row).toMatchObject({ agentId: bot.id, personaSlug: custom.slug, skillPinsVersion: 1 });
    expect(row.skillPins).toEqual([expect.objectContaining({ skillVersionId: objections.version.id, alias: objections.slug, position: 0 })]);
    expect(row.compiledSnapshot).toMatchObject({ twinSkills: [{ slug: objections.slug, version: 1, skillVersionId: objections.version.id }] });
  });

  test("a role play with several personas plays one picked at random; with one, its default", async () => {
    const second = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second", data: {} } });
    expect(await pickSessionPersona(f.roleplay.id)).toBeNull();
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [
      { personaId: persona.id, active: true }, { personaId: second.id, active: true },
    ], tx));
    const random = spyOn(Math, "random");
    spies.push(random);
    random.mockReturnValue(0.99);
    expect(await pickSessionPersona(f.roleplay.id)).toBe(second.id);
    random.mockReturnValue(0);
    expect(await pickSessionPersona(f.roleplay.id)).toBe(persona.id);
    const config = await getAgentConfigForAgent(f.roleplay.id, f.org.id, undefined, undefined, undefined, undefined, second.id);
    expect(config?.persona.slug).toBe(second.slug);
  });

  test("the database keeps each kind's personas: twin one own, bot one, role play at least one", async () => {
    const custom = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-custom`, name: "Custom", data: {} } });
    await expect(db.$transaction((tx) => setAgentPersonas(f.twin.id, [{ personaId: custom.id, active: true }], tx))).rejects.toThrow();
    await expect(db.$transaction((tx) => setAgentPersonas(f.twin.id, [
      { personaId: persona.id, active: true }, { personaId: custom.id, active: true },
    ], tx))).rejects.toThrow();
    await expect(db.$transaction(async (tx) => {
      await tx.agentPersona.updateMany({ where: { agentId: f.roleplay.id }, data: { active: false } });
    })).rejects.toThrow();
    expect(await db.agentPersona.findMany({ where: { agentId: f.twin.id }, select: { personaId: true } })).toEqual([{ personaId: persona.id }]);
  });
});
