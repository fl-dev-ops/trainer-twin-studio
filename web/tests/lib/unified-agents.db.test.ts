import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as workflow from "workflow/api";
import * as livekit from "@/lib/livekit";
import { attachTwinSkillToMainTwin, supportingCatalog, setSupportingSkills } from "@/lib/agent-skills";
import { pickSessionPersona, setAgentPersonas } from "@/lib/agent-personas";
import { createBot, saveBotPublic, saveBotSkills } from "@/lib/bots";
import { getAgentConfigForAgent } from "@/lib/specs";
import { sessionPersonaView } from "@/lib/persona-media";
import { getPersona, PersonaInUseError, removePersonaRecord } from "@/lib/personas";
import { resolveTwinCatalog } from "@/lib/twins";
import { startPublicTwinSession } from "@/lib/public-twin-sessions";
import { skillPackageHash } from "@/lib/skills";
import { orgPrefix } from "@/lib/s3";
import { fundOrg } from "../setup/meteroid";
import { runCopilotStudio } from "@/lib/copilot-studio";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { ROLEPLAY_SOURCE } from "@/lib/scenario-ingest";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { giveCharacters } from "../setup/characters";

/** Twins, role plays and bots share one shape (specs/agents.md): main skill, supporting skills, persona(s). */
describe.skipIf(!localMinutesDb)("unified agents: supporting skills and personas (real database)", () => {
  let f: MinutesFixture;
  let persona: { id: string; slug: string };
  const spies: { mockRestore(): void }[] = [];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");

  beforeEach(async () => {
    f = minutesFixture();
    await f.create({ voice: true });
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
    await db.agent.update({ where: { slug }, data: { primarySkillId: skill.id } });
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
    const { voiceId } = await db.persona.findUniqueOrThrow({ where: { id: persona.id }, select: { voiceId: true } });
    const custom = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-guide`, name: "Guide", data: {}, voiceId } });
    const objections = await topicSkill("objections");
    const bot = await db.$transaction(async (tx) => {
      const made = (await createBot(f.org.id, { personaId: custom.id, name: "Homepage", objective: "Welcome visitors." }, tx))!;
      const withSkills = (await saveBotSkills(made, [{ skillId: objections.skill.id, active: true }], tx))!;
      return (await saveBotPublic(withSkills, { publicAccess: { enabled: true } }, tx))!;
    });
    expect(bot).toMatchObject({ personaId: custom.id, data: { source: "bot", objective: "Welcome visitors." } });
    expect(bot.data).not.toHaveProperty("twinId");
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const realFetch = globalThis.fetch;
    spies.push(
      spyOn(workflow, "start").mockResolvedValue(undefined as never),
      spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined),
      spyOn(livekit, "activateLiveKitSession").mockImplementation(async (input) => ({
        room: input.sessionId, token: "token", dispatchId: "dispatch", videoEgressId: null, videoS3Key: null,
      })),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("meteroid.test")) return realFetch(url, init);
        if (new URL(String(url)).pathname === "/internal/sessions") return new Response(null, { status: 204 });
        throw new Error(`Unexpected network request: ${String(url)}`);
      }),
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
    await giveCharacters(f.roleplay.id);
    const random = spyOn(Math, "random");
    spies.push(random);
    random.mockReturnValue(0.99);
    expect(await pickSessionPersona(f.roleplay.id)).toBe(second.id);
    random.mockReturnValue(0);
    expect(await pickSessionPersona(f.roleplay.id)).toBe(persona.id);
    const config = await getAgentConfigForAgent(f.roleplay.id, f.org.id, undefined, undefined, undefined, undefined, second.id);
    expect(config?.persona.slug).toBe(second.slug);
  });

  test("a role play's extra persona: its call screen shows it, and it counts as used (no delete, listed in used by)", async () => {
    const second = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second", data: { name: "Daniel Hart" } } });
    await db.$transaction((tx) => setAgentPersonas(f.roleplay.id, [
      { personaId: persona.id, active: true }, { personaId: second.id, active: false },
    ], tx));
    // The call screen names who this session recorded, not the role play's main persona.
    const session = await f.session({ personaSlug: second.slug });
    expect(await sessionPersonaView(f.org.id, session.id)).toEqual({ slug: second.slug, name: "Daniel Hart", photoUrl: null });
    // Only an extra (even switched off): still in use, so it can't be deleted and its page lists the role play.
    expect((await getPersona(f.org.id, second.slug))?.usedBy.map((agent) => agent.slug)).toEqual([f.roleplay.slug]);
    await expect(removePersonaRecord(f.org.id, second.slug)).rejects.toBeInstanceOf(PersonaInUseError);
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

  test("the copilot sets a main twin's skills and a role play's extra personas, and manages bots, by slug", async () => {
    const actor = { org: { id: f.org.id, slug: f.org.slug }, user: { id: f.trainer.id, name: "Trainer" } };
    const silent = await topicSkill("silent");
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin" } } });
    await runCopilotStudio(actor, { action: "setTwinSkills", slug: f.twin.slug, skills: [{ slug: silent.slug, active: true }] });
    expect(await db.agentSkill.findMany({ where: { agentId: f.twin.id }, select: { skillId: true, active: true } })).toEqual([{ skillId: silent.skill.id, active: true }]);
    await expect(runCopilotStudio(actor, { action: "setTwinSkills", slug: f.roleplay.slug, skills: [] })).rejects.toThrow("not a main twin");
    await expect(runCopilotStudio(actor, { action: "setTwinSkills", slug: f.twin.slug, skills: [{ slug: "missing", active: true }] })).rejects.toThrow("was not found");

    const second = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second", data: {} } });
    await runCopilotStudio(actor, { action: "setRoleplayPersonas", slug: f.roleplay.slug, extras: [{ slug: second.slug, active: true }] });
    expect(await db.agentPersona.findMany({ where: { agentId: f.roleplay.id }, orderBy: { position: "asc" }, select: { personaId: true, active: true } }))
      .toEqual([{ personaId: persona.id, active: true }, { personaId: second.id, active: true }]);

    const created = await runCopilotStudio(actor, { action: "createBot", persona: second.slug, name: "Homepage", objective: "Welcome visitors." }) as { slug: string };
    await runCopilotStudio(actor, { action: "updateBot", slug: created.slug, objective: "Answer questions.", skills: [{ slug: silent.slug, active: false }] });
    expect(await runCopilotStudio(actor, { action: "getBot", slug: created.slug })).toMatchObject({
      name: "Homepage", persona: second.slug, objective: "Answer questions.", publicCalls: "off", skills: [{ slug: silent.slug, active: false }],
    });
  });

  test("editing a role play's persona selection does not republish and can replace its original persona", async () => {
    const second = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second", data: {} } });
    const third = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-third`, name: "Third", data: {} } });
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { source: ROLEPLAY_SOURCE } } });
    const caller = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } } as never);
    const version = (await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).version;
    const slug = f.roleplay.slug;
    await runCopilotStudio({ org: f.org, user: f.trainer }, { action: "setRoleplayPersonas", slug, extras: [{ slug: third.slug, active: false }] });
    expect(await caller.builder.personaPool({ slug })).toEqual([persona.slug]);
    await expect(caller.builder.setPersonaPool({ slug, personas: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.builder.setPersonaPool({ slug, personas: ["missing"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await caller.builder.setPersonaPool({ slug, personas: [second.slug, persona.slug, second.slug] });
    expect(await caller.builder.personaPool({ slug })).toEqual([persona.slug, second.slug]);
    await caller.builder.setPersonaPool({ slug, personas: [third.slug, second.slug] });
    expect(await caller.builder.personaPool({ slug })).toEqual([third.slug, second.slug]);
    expect(await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).toMatchObject({ version, personaId: third.id });
    // Other publication paths can still replace the default without dropping the remaining pool.
    await db.agent.update({ where: { id: f.roleplay.id }, data: { personaId: persona.id } });
    expect(await caller.builder.personaPool({ slug })).toEqual([persona.slug, second.slug]);
  });

  test("a newly published twin skill joins a merged main twin at the end; an unmerged twin is left as it was", async () => {
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin" } } });
    const attachedTo = async () => (await db.agentSkill.findMany({ where: { agentId: f.twin.id }, orderBy: { position: "asc" }, select: { skill: { select: { ownerSlug: true } }, active: true } }))
      .map((row) => `${row.skill.ownerSlug.replace(`${f.org.slug}-`, "")}${row.active ? "" : " (off)"}`);
    const first = await topicSkill("first");
    const attach = (skillId: string) => db.$transaction((tx) => attachTwinSkillToMainTwin(f.org.id, persona.id, skillId, tx));
    await attach(first.skill.id);
    expect(await attachedTo()).toEqual([]);
    // Merged: a later skill goes at the end; switched-off ones keep their state; repeating is a no-op.
    await db.$transaction((tx) => setSupportingSkills(f.org.id, f.twin.id, [{ skillId: first.skill.id, active: false }], tx));
    const second = await topicSkill("second");
    const third = await topicSkill("third");
    await Promise.all([attach(second.skill.id), attach(third.skill.id), attach(second.skill.id)]);
    const [existing, ...added] = await attachedTo();
    expect(existing).toBe("first (off)");
    expect(added.sort()).toEqual(["second", "third"]);
  });


  test("bots exist only in orgs with the bots flag: API, copilot and widget lookups refuse elsewhere", async () => {
    const admin = (await import("@/lib/twin/trpc")).twinRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } } as never);
    const made = await admin.bots.create({ personaId: persona.id, name: "Homepage", objective: "Welcome visitors." });
    const bot = await db.agent.findUniqueOrThrow({ where: { slug: made.slug }, select: { id: true } });
    await db.organization.update({ where: { id: f.org.id }, data: { metadata: JSON.stringify({}) } });
    await expect(admin.bots.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runCopilotStudio({ org: { id: f.org.id, slug: f.org.slug }, user: { id: f.trainer.id, name: "Trainer" } }, { action: "listBots" })).rejects.toThrow();
    expect(await (await import("@/lib/bots")).publicBot(f.org.id, bot.id)).toBeNull();
  });
});
