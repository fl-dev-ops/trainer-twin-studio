import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as livekit from "@/lib/livekit";
import * as ending from "@/lib/session-end";
import * as schedule from "@/lib/schedule-org-credits";
import * as s3 from "@/lib/s3";
import { setPersonaVoice, setPersonaVoiceFrom } from "@/lib/persona-media";
import { activateSession } from "@/lib/interview-sessions";
import { connectVoice } from "@/lib/session-activation";
import { readAgentSkillVersion } from "@/lib/skill-history";
import { skillPackageHash } from "@/lib/skills";
import { attachPersonaVoice } from "@/lib/voices";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase || !localMinutesDb)("own-persona voice selection and copied twin overrides (real Postgres)", () => {
  let f: MinutesFixture;
  let secret: string | undefined;
  let oldVoiceId: string;
  let nextVoiceId: string;
  let roleplayVoiceId: string;
  let skillId: string;
  let skillVersionId: string;
  let managedTwinId: string;
  const globalPersonas: string[] = [];
  const globalVoices: string[] = [];
  const files = new Map<string, Uint8Array | string>();
  const spies: { mockRestore(): void }[] = [];
  let deleting: ReturnType<typeof spyOn<typeof s3, "deleteObject">>;
  let connecting: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;

  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    await fundOrg({ orgId: f.org.id, minutes: 1000 });
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "own-persona-voice-test-secret";
    files.clear(); globalPersonas.length = 0; globalVoices.length = 0;
    const fetch = globalThis.fetch;
    deleting = spyOn(s3, "deleteObject").mockResolvedValue(undefined);
    connecting = spyOn(livekit, "activateLiveKitSession").mockResolvedValue({
      token: "participant", room: "local-room", dispatchId: "local-dispatch", videoEgressId: null, videoS3Key: null,
    });
    spies.push(deleting, connecting,
      spyOn(s3, "putObject").mockImplementation(async (key, bytes) => { files.set(key, bytes); }),
      spyOn(ending, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(schedule, "scheduleOrgUsage").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.hostname === "meteroid.test") return fetch(url, init);
        if (parsed.pathname === "/internal/sessions") return new Response(null, { status: 204 });
        throw new Error(`Unexpected network call: ${url}`);
      }),
    );
    const voices = [];
    for (const name of ["Original trainer", "Selected trainer", "Role-play override"]) {
      const id = randomUUID();
      voices.push(await db.voice.create({ data: {
        id, orgId: f.org.id, name, kind: "cloned", status: "ready",
        s3AudioKey: `${s3.voicePrefix(f.org.id, id)}/reference.wav`,
      } }));
    }
    [oldVoiceId, nextVoiceId, roleplayVoiceId] = voices.map((voice) => voice.id);
    await attachPersonaVoice(f.org.id, f.org.slug, oldVoiceId);
    const avatarId = randomUUID();
    const avatar = await db.avatar.create({ data: {
      id: avatarId, orgId: f.org.id, name: "Trainer avatar",
      s3ImageKey: `${s3.avatarPrefix(f.org.id, avatarId)}/image/photo.jpg`,
      s3OriginalImageKey: `${s3.avatarPrefix(f.org.id, avatarId)}/image/original.jpg`,
      s3VideoKey: `${s3.avatarPrefix(f.org.id, avatarId)}/video/original.webm`,
    } });
    const persona = await db.persona.update({
      where: { orgId_slug: { orgId: f.org.id, slug: f.org.slug } }, data: { avatarId: avatar.id },
    });
    await db.agent.update({ where: { id: f.twin.id }, data: {
      version: 3, data: { objective: "Keep trainer behavior", source: "legacy-trainer", voiceId: oldVoiceId, hiddenTrainerField: "Keep this" },
    } });
    await db.agent.update({ where: { id: f.roleplay.id }, data: {
      data: { objective: "Role-play practice", voiceId: roleplayVoiceId },
    } });
    const managedTwin = await db.agent.create({ data: {
      orgId: f.org.id, personaId: persona.id, slug: `${f.org.slug}-managed`, name: "Managed trainer", kind: "TWIN",
      version: 4, data: {},
    } });
    managedTwinId = managedTwin.id;
    const skill = await db.skill.create({ data: { orgId: f.org.id, ownerSlug: managedTwin.slug, name: "Trainer skill" } });
    skillId = skill.id;
    const text = "# Trainer skill\nKeep the published skill.\n";
    const manifest = { skill: "trainer-skill", name: "Trainer skill", situations: [] };
    const packageFiles = { "SKILL.md": text, "skill.json": JSON.stringify(manifest), "items.json": "[]" };
    const version = await db.skillVersion.create({ data: {
      skillId, version: 1, format: "twin", status: "ready", indexStatus: "ready", skillText: text, manifest,
      files: packageFiles, contentHash: skillPackageHash("twin", packageFiles), itemCount: 0,
      artifacts: `${s3.orgPrefix(f.org.id)}/skills/${skillId}/v1`,
    } });
    skillVersionId = version.id;
    await db.skill.update({ where: { id: skillId }, data: { currentVersionId: version.id } });
    await db.agent.update({ where: { id: managedTwin.id }, data: {
      primarySkillId: skillId,
      data: {
        objective: "Managed trainer", source: "twin-creator", voiceId: oldVoiceId, hiddenTrainerField: "Keep this too",
        skill: text, scenario: manifest, artifacts: version.artifacts, filesHash: version.contentHash,
      },
    } });
    await db.agentSkillVersion.create({ data: {
      orgId: f.org.id, agentId: managedTwin.id, agentVersion: 4, skillVersionId: version.id,
    } });
    await db.$executeRaw`
      INSERT INTO "SkillOwnership" ("orgId", mode, "inventoryHash", "canaryReference", "verifiedAt", "approvedAt")
      VALUES (${f.org.id}, 'managed', 'own-voice-test-inventory', 'isolated-fixture:not-live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  });

  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
    await db.voice.deleteMany({ where: { orgId: f.org.id } });
    await db.persona.deleteMany({ where: { id: { in: globalPersonas } } });
    await db.voice.deleteMany({ where: { id: { in: globalVoices } } });
  });

  const persona = () => db.persona.findUniqueOrThrow({
    where: { orgId_slug: { orgId: f.org.id, slug: f.org.slug } }, include: { avatar: true },
  });
  const start = async (agentSlug = f.twin.slug) => {
    const session = await activateSession({ orgId: f.org.id, userId: f.trainer.id, agentSlug, mode: "voice" });
    if (!session) throw new Error("Expected a voice session");
    return session;
  };
  const sessionRow = (id: string) => db.interviewSession.findUniqueOrThrow({ where: { id } });

  test.each(["library", "upload"] as const)("%s selection retires twin copies atomically while preserving role-play overrides, history, skills and avatars", async (method) => {
    const beforePersona = await persona();
    const beforeVoices = await db.voice.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
    const beforeRoleplay = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const oldSession = await start();
    const oldSnapshot = await sessionRow(oldSession.id);
    expect(oldSnapshot.resolvedVoiceId).toBe(oldVoiceId);
    const selected = method === "library"
      ? await setPersonaVoiceFrom(f.org.id, f.org.slug, nextVoiceId)
      : await setPersonaVoice(f.org.id, f.org.slug, {
          audio: new File(["RIFF test fixture"], "trainer.wav", { type: "audio/wav" }), transcript: "Trainer reference passage.",
        });
    const afterPersona = await persona();
    expect(afterPersona.voiceId).toBe(selected.voiceId);
    expect(afterPersona.avatar).toEqual(beforePersona.avatar);
    expect(afterPersona.data).toEqual(beforePersona.data);
    expect(afterPersona.settings).toEqual(beforePersona.settings);
    expect(afterPersona.version).toBe(beforePersona.version);
    const legacy = await db.agent.findUniqueOrThrow({ where: { id: f.twin.id } });
    const managed = await db.agent.findUniqueOrThrow({ where: { id: managedTwinId } });
    expect(legacy).toMatchObject({ version: 4, data: {
      objective: "Keep trainer behavior", source: "legacy-trainer", hiddenTrainerField: "Keep this",
    } });
    expect(legacy.data).not.toHaveProperty("voiceId");
    expect(managed).toMatchObject({ version: 5, primarySkillId: skillId, data: {
      objective: "Managed trainer", source: "twin-creator", hiddenTrainerField: "Keep this too",
    } });
    for (const key of ["voiceId", "skill", "scenario", "artifacts", "filesHash"]) expect(managed.data).not.toHaveProperty(key);
    expect((await readAgentSkillVersion(f.org.id, managedTwinId, 4))?.id).toBe(skillVersionId);
    expect((await readAgentSkillVersion(f.org.id, managedTwinId, 5))?.id).toBe(skillVersionId);
    const history = await db.specVersion.findMany({ where: { orgId: f.org.id }, orderBy: { entitySlug: "asc" } });
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.entitySlug === legacy.slug)).toMatchObject({
      version: 3, data: { voiceId: oldVoiceId, hiddenTrainerField: "Keep this" },
    });
    expect(history.find((row) => row.entitySlug === managed.slug)).toMatchObject({
      version: 4, data: { voiceId: oldVoiceId, hiddenTrainerField: "Keep this too" },
    });
    expect(history.find((row) => row.entitySlug === managed.slug)?.data).not.toHaveProperty("skill");
    expect(await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).toEqual(beforeRoleplay);
    await connectVoice({ orgId: f.org.id, userId: f.trainer.id, mode: "voice" }, { ...oldSession, resumed: true });
    expect(connecting).toHaveBeenLastCalledWith(expect.objectContaining({ voice: oldVoiceId }));
    expect((await sessionRow(oldSession.id)).compiledSnapshot).toEqual(oldSnapshot.compiledSnapshot);
    expect((await sessionRow((await start()).id)).resolvedVoiceId).toBe(selected.voiceId);
    expect((await sessionRow((await start(managed.slug)).id)).resolvedVoiceId).toBe(selected.voiceId);
    expect((await sessionRow((await start(f.roleplay.slug)).id)).resolvedVoiceId).toBe(roleplayVoiceId);
    const versions = await db.agent.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
    await setPersonaVoiceFrom(f.org.id, f.org.slug, selected.voiceId);
    expect(await db.agent.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } })).toEqual(versions);
    for (const voice of beforeVoices) expect(await db.voice.findUniqueOrThrow({ where: { id: voice.id } })).toEqual(voice);
    expect(await db.voice.count({ where: { orgId: f.org.id } })).toBe(beforeVoices.length + (method === "upload" ? 1 : 0));
    expect(deleting).not.toHaveBeenCalled();
    expect((await persona()).avatar).toEqual(beforePersona.avatar);
  });

  test("a skill-history carry conflict rolls back attachment and every twin version without editing the avatar", async () => {
    const original = await db.skillVersion.findUniqueOrThrow({ where: { id: skillVersionId } });
    const text = "# A different future package\n";
    const packageFiles = { "SKILL.md": text, "skill.json": JSON.stringify(original.manifest), "items.json": "[]" };
    const future = await db.skillVersion.create({ data: {
      skillId, version: 2, format: "twin", status: "ready", indexStatus: "ready", skillText: text,
      manifest: original.manifest ?? {}, files: packageFiles, contentHash: skillPackageHash("twin", packageFiles),
      itemCount: 0, artifacts: `${s3.orgPrefix(f.org.id)}/skills/${skillId}/v2`,
    } });
    await db.agentSkillVersion.create({ data: {
      orgId: f.org.id, agentId: managedTwinId, agentVersion: 5, skillVersionId: future.id,
    } });
    const beforePersona = await persona();
    const beforeAgents = await db.agent.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
    const beforeMappings = await db.agentSkillVersion.findMany({ where: { orgId: f.org.id }, orderBy: { agentVersion: "asc" } });
    await expect(setPersonaVoiceFrom(f.org.id, f.org.slug, nextVoiceId)).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect(await persona()).toEqual(beforePersona);
    expect(await db.agent.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } })).toEqual(beforeAgents);
    expect(await db.agentSkillVersion.findMany({ where: { orgId: f.org.id }, orderBy: { agentVersion: "asc" } })).toEqual(beforeMappings);
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(deleting).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  test("ordinary personas and privileged global uploads retain their normal attachment behavior", async () => {
    const beforeAgents = await db.agent.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
    const character = await db.persona.create({ data: {
      orgId: f.org.id, slug: `${f.org.slug}-character`, name: "Fictional client", data: {}, isOwn: false,
    } });
    expect(await setPersonaVoiceFrom(f.org.id, character.slug, nextVoiceId)).toMatchObject({ voiceId: nextVoiceId });
    const preset = await db.persona.create({ data: {
      orgId: null, slug: `voice-preset-test-${randomUUID()}`, name: "Global fixture", data: {}, isOwn: false,
    } });
    globalPersonas.push(preset.id);
    const selected = await setPersonaVoice(null, preset.slug, {
      audio: new File(["RIFF global fixture"], "preset.wav", { type: "audio/wav" }),
    });
    globalVoices.push(selected.voiceId);
    const voice = await db.voice.findUniqueOrThrow({ where: { id: selected.voiceId } });
    expect(voice.orgId).toBeNull();
    expect(voice.s3AudioKey.startsWith(`${s3.voicePrefix(null, voice.id)}/`)).toBe(true);
    expect(await db.persona.findUniqueOrThrow({ where: { id: preset.id } })).toMatchObject({ voiceId: voice.id, avatarId: null });
    expect(await db.agent.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } })).toEqual(beforeAgents);
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(deleting).not.toHaveBeenCalled();
  });
});
