import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import * as specs from "@/lib/specs";
import * as knowledge from "@/lib/knowledge";
import { activateSession } from "@/lib/interview-sessions";
import { buildSessionContext } from "@/lib/session-context";
import { loadRoleplaySessionSkill, resolveRoleplaySnapshotSkill } from "@/lib/session-skills";
import { skillFiles, skillPackageHash } from "@/lib/skills";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { RoleplayBuilder } from "@/lib/roleplay/skill";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { giveCharacters } from "../setup/characters";

const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3,
  s3Configured: true,
  putObject: mock(async (key: string, body: string) => { files.set(key, body); }),
  getObjectText: mock(async (key: string) => {
    const body = files.get(key);
    if (body === undefined) throw new Error(`Missing test object: ${key}`);
    return body;
  }),
}));
const { ingestScenario, saveRoleplay } = await import("@/lib/scenario-ingest");
const { POST } = await import("@/app/api/copilot/studio/route");

describe.skipIf(!localMinutesDb)("Phase 2 session skill pins (real Postgres)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let secret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  let managedSearch: ReturnType<typeof spyOn<typeof MainCollectionService, "searchSkillItems">>;
  let legacySearch: ReturnType<typeof spyOn<typeof MainCollectionService, "searchScenarioItems">>;

  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create(); await other.create();
    files.clear();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "session-skills-test-secret";
    spies.push(
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _id, _scenario, items) => items.length),
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call: ${url}`);
        return new Response(null, { status: 204 });
      }),
      spyOn(knowledge, "embedTexts").mockResolvedValue([[0.1, 0.2]]),
    );
    managedSearch = spyOn(MainCollectionService, "searchSkillItems").mockResolvedValue([]);
    legacySearch = spyOn(MainCollectionService, "searchScenarioItems").mockResolvedValue([]);
    spies.push(managedSearch, legacySearch);
  });

  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    for (const fixture of [other, f]) {
      await db.interviewSession.deleteMany({ where: { orgId: fixture.org.id } });
      await db.contextDocument.deleteMany({ where: { orgId: fixture.org.id } });
      await db.agent.updateMany({ where: { orgId: fixture.org.id }, data: { primarySkillId: null } });
      await db.skill.updateMany({ where: { orgId: fixture.org.id }, data: { currentVersionId: null } });
      await db.agentSkillVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skillVersionSource.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skillVersion.deleteMany({ where: { skill: { orgId: fixture.org.id } } });
      await db.skill.deleteMany({ where: { orgId: fixture.org.id } });
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
  });

  const builder = (revision = 1): RoleplayBuilder => ({
    name: "Pinned practice", persona: f.org.slug,
    situation: { scenario: `Buyer concern ${revision}`, learnerRole: "Advisor" },
    difficulty: "medium", exampleLines: [`Concern ${revision}`],
    learnerGoals: [`Goal ${revision}`],
    rubric: [{ name: `Rubric ${revision}`, points: 100 }],
  });
  const publish = async (format: "builder" | "authored" = "builder", revision = 1, personaSlug = f.org.slug) => {
    if (format === "builder") return saveRoleplay(f.org.id, { ...builder(revision), persona: personaSlug }, f.roleplay.slug);
    return ingestScenario(f.org.id, {
      kind: "ROLEPLAY", personaSlug, skill: `# Pinned authored ${revision}\n`,
      scenario: {
        scenario: "pinned-authored", name: "Pinned authored", description: `Revision ${revision}`,
        trainer_role: "Buyer", learner_role: "Advisor",
        steps: [{ id: `step-${revision}`, name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }],
      },
      items: [{ id: `line-${revision}`, role: "trainer", context: "Opening", text: `Concern ${revision}`, metadata: { step: `step-${revision}` } }],
    });
  };
  const start = async (slug = f.roleplay.slug, idempotencyKey = randomUUID()) => {
    await giveCharacters({ slug });
    const session = await activateSession({ orgId: f.org.id, userId: f.trainer.id, agentSlug: slug, mode: "chat", idempotencyKey });
    if (!session) throw new Error("Activation returned no session");
    return session;
  };
  const search = (sessionId: string, agentSlug: string, orgId = f.org.id, extra: Record<string, unknown> = {}) => POST(new Request("http://localhost/api/copilot/studio", {
    method: "POST",
    headers: { authorization: "Bearer session-skills-test-secret", "x-trainertwin-org-id": orgId, "content-type": "application/json" },
    body: JSON.stringify({ action: "searchScenarioItems", sessionId, agentSlug, query: "buyer concern", limit: 3, ...extra }),
  }));
  const pinnedRow = (id: string) => db.interviewSession.findUniqueOrThrow({ where: { id }, include: { skillPins: { include: { version: true } } } });

  test.each(["builder", "authored"] as const)("%s context, search metadata, scoring and resume stay pinned after v2/v3", async (format) => {
    const saved = await publish(format);
    const key = randomUUID();
    const call = await start(saved.slug, key);
    const before = await pinnedRow(call.id);
    const context = await buildSessionContext({ orgId: f.org.id, sessionId: call.id, agentSlug: saved.slug });
    const [pin] = before.skillPins;
    expect(before.skillPinsVersion).toBe(1);
    expect(before.skillPins).toHaveLength(1);
    expect(pin).toMatchObject({ orgId: f.org.id, alias: saved.slug, position: 0 });
    expect(pin.version.version).toBe(1);
    if (format === "builder") expect(before.compiledSnapshot).toMatchObject({
      agent: { data: { after: { goals: ["Goal 1"], rubric: [{ name: "Rubric 1", points: 100 }] } } },
    });
    for (const revision of [2, 3]) {
      await publish(format, revision);
      expect(await buildSessionContext({ orgId: f.org.id, sessionId: call.id, agentSlug: saved.slug })).toEqual(context);
      expect((await search(call.id, saved.slug)).status).toBe(200);
      const manifest = pin.version.manifest;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Expected package manifest");
      expect(managedSearch).toHaveBeenLastCalledWith(f.org.id, [{
        skillVersionId: pin.skillVersionId, indexScope: pin.version.artifacts, itemCount: pin.version.itemCount,
      }], "buyer concern", {
        role: format === "builder" ? "client" : "trainer", step: undefined, limit: 3,
        steps: manifest.steps ?? manifest.situations ?? [],
      });
    }
    const resumed = await start(saved.slug, key);
    expect(resumed).toMatchObject({ id: call.id, resumed: true });
    const after = await pinnedRow(call.id);
    expect(after.skillPins).toEqual(before.skillPins);
    expect(after.compiledSnapshot).toEqual(before.compiledSnapshot);
    expect(after.agentVersion).toBe(before.agentVersion);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("exact experience mappings override compatibility artifacts; only unmapped versions use saved artifacts", async () => {
    await publish();
    const original = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const first = await resolveRoleplaySnapshotSkill(f.org.id, original);
    await publish("builder", 2);
    const current = await db.agent.findUniqueOrThrow({ where: { id: original.id } });
    const second = await resolveRoleplaySnapshotSkill(f.org.id, current);
    expect(second.id).not.toBe(first.id);
    expect((await resolveRoleplaySnapshotSkill(f.org.id, original)).id).toBe(first.id);
    await db.agent.update({ where: { id: original.id }, data: { data: original.data ?? {} } });
    const call = await start();
    expect((await pinnedRow(call.id)).skillPins[0].skillVersionId).toBe(second.id);
    await db.interviewSession.update({ where: { id: call.id }, data: { status: "completed", endedAt: new Date() } });
    const mapping = await db.agentSkillVersion.findUniqueOrThrow({
      where: { agentId_agentVersion: { agentId: original.id, agentVersion: current.version } },
    });
    await db.agentSkillVersion.delete({
      where: { agentId_agentVersion: { agentId: original.id, agentVersion: current.version } },
    });
    const fallback = await start();
    expect((await pinnedRow(fallback.id)).skillPins[0].skillVersionId).toBe(first.id);
    await db.agentSkillVersion.create({ data: mapping });
    const restored = await db.agent.findUniqueOrThrow({ where: { id: original.id } });
    expect((await resolveRoleplaySnapshotSkill(f.org.id, restored)).id).toBe(second.id);
    expect((await pinnedRow(call.id)).skillPins[0].skillVersionId).toBe(second.id);
    expect((await pinnedRow(fallback.id)).skillPins[0].skillVersionId).toBe(first.id);
  });

  test("import deduplicates settings versions without rewriting an active session's original package, persona or scoring", async () => {
    const input = {
      kind: "ROLEPLAY" as const, personaSlug: f.org.slug, skill: "# Imported authored practice\nAsk before advising.\n",
      patterns: "# Evidence\nOriginal source wording.\n",
      scenario: {
        scenario: "imported-authored", name: "Imported authored", description: "Explore the concern",
        trainer_role: "Client", learner_role: "Advisor",
        steps: [{ id: "opening", name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }],
      },
      items: [{ id: "line-1", role: "trainer" as const, context: "Opening", text: "What concerns you?", metadata: { step: "opening" } }],
    };
    const saved = await ingestScenario(f.org.id, input);
    const call = await start(saved.slug);
    const before = await pinnedRow(call.id);
    const originalContext = await buildSessionContext({ orgId: f.org.id, sessionId: call.id, agentSlug: saved.slug });
    const snapshot = before.compiledSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Expected compiled snapshot");
    const historical = await f.session({
      agentId: before.agentId, agentSlug: saved.slug, agentVersion: saved.version,
      personaSlug: before.personaSlug, personaVersion: before.personaVersion,
      compiledSnapshot: snapshot, skillPinsVersion: null,
    });
    const historicalBefore = await pinnedRow(historical.id);
    const historicalContext = await buildSessionContext({ orgId: f.org.id, sessionId: historical.id, agentSlug: saved.slug });
    expect(historicalBefore.skillPinsVersion).toBeNull();
    expect(historicalBefore.skillPins).toEqual([]);
    const persona = await db.persona.create({ data: {
      orgId: f.org.id, slug: `${f.org.slug}-changed`, name: "Changed client", data: { identity: "Changed client" }, version: 4,
    } });
    const changed = await ingestScenario(f.org.id, { ...input, personaSlug: persona.slug });
    expect(changed.version).toBeGreaterThan(saved.version);
    const owner = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug } });
    expect(await db.agentSkillVersion.findMany({
      where: { agentId: owner.id }, orderBy: { agentVersion: "asc" },
    })).toEqual([
      expect.objectContaining({ agentVersion: saved.version, skillVersionId: before.skillPins[0].skillVersionId }),
      expect.objectContaining({ agentVersion: changed.version, skillVersionId: before.skillPins[0].skillVersionId }),
    ]);
    spies.push(spyOn(MainCollectionService, "skillItemCount").mockResolvedValue(1));
    const { migrateSkills } = await import("@/lib/skill-migration");
    const versions = await db.skillVersion.findMany({ where: { skillId: before.skillPins[0].version.skillId } });
    const preImportSession = await pinnedRow(call.id);
    expect(preImportSession.compiledSnapshot).toEqual(before.compiledSnapshot);
    expect(preImportSession.skillPins.map(({ version, ...pin }) => ({ ...pin, contentHash: version.contentHash }))).toEqual(
      before.skillPins.map(({ version, ...pin }) => ({ ...pin, contentHash: version.contentHash })),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await migrateSkills(f.org.id, { apply: true });
      expect(report).toMatchObject({ complete: true, currentGaps: [], requiredGaps: [], historicalGaps: [] });
      expect(report.entries.filter((entry) => entry.slug === saved.slug)).toHaveLength(2);
      expect(report.entries.every((entry) => entry.skillVersionId === before.skillPins[0].skillVersionId)).toBe(true);
      expect(await pinnedRow(call.id)).toEqual(preImportSession);
      expect(await pinnedRow(historical.id)).toEqual(historicalBefore);
      expect(await buildSessionContext({ orgId: f.org.id, sessionId: historical.id, agentSlug: saved.slug })).toEqual(historicalContext);
      expect(await buildSessionContext({ orgId: f.org.id, sessionId: call.id, agentSlug: saved.slug })).toEqual(originalContext);
      expect(await db.skillVersion.findMany({ where: { skillId: before.skillPins[0].version.skillId } })).toEqual(versions);
    }
    expect((await search(call.id, saved.slug)).status).toBe(200);
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, [{
      skillVersionId: before.skillPins[0].skillVersionId, indexScope: before.skillPins[0].version.artifacts,
      itemCount: before.skillPins[0].version.itemCount,
    }], "buyer concern", expect.objectContaining({ role: "trainer" }));
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("publishing after the outer compile yields one coherent locked Agent/persona/package snapshot", async () => {
    await publish();
    const secondPersona = await db.persona.create({ data: {
      orgId: f.org.id, slug: `${f.org.slug}-second`, name: "Second buyer", version: 7, data: { identity: "Second buyer" },
    } });
    const compile = specs.getAgentConfigForAgent;
    let published = false;
    spies.push(spyOn(specs, "getAgentConfigForAgent").mockImplementation(async (...args) => {
      const config = await compile(...args);
      if (!published && !args[4]) {
        published = true;
        await publish("builder", 2, secondPersona.slug);
      }
      return config;
    }));
    const call = await start();
    const row = await pinnedRow(call.id);
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    expect(published).toBe(true);
    expect(row).toMatchObject({ agentVersion: agent.version, personaSlug: secondPersona.slug, personaVersion: 7 });
    expect(row.compiledSnapshot).toMatchObject({
      agent: { version: agent.version, primarySkillId: agent.primarySkillId, data: { artifacts: row.skillPins[0].version.artifacts, after: { goals: ["Goal 2"] } } },
      persona: { slug: secondPersona.slug, version: 7 },
    });
    expect(row.skillPins[0].version.version).toBe(2);
  });

  test.each(["unknown", "wrong-org", "wrong-agent"] as const)("%s session refuses context and search without reaching either index", async (scope) => {
    await publish();
    const call = await start();
    const sessionId = scope === "unknown" ? randomUUID() : call.id;
    const orgId = scope === "wrong-org" ? other.org.id : f.org.id;
    const agentSlug = scope === "wrong-agent" ? f.twin.slug : f.roleplay.slug;
    await expect(buildSessionContext({ orgId, sessionId, agentSlug })).rejects.toMatchObject({ code: "not_found", status: 404 });
    const response = await search(sessionId, agentSlug, orgId);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("a managed pending index fails closed for context, search and new activation", async () => {
    await publish();
    const call = await start();
    const row = await pinnedRow(call.id);
    await db.skillVersion.update({ where: { id: row.skillPins[0].skillVersionId }, data: { indexStatus: "pending" } });
    await expect(buildSessionContext({ orgId: f.org.id, sessionId: call.id })).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect((await search(call.id, f.roleplay.slug)).status).toBe(503);
    await expect(start()).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  test("managed provider unavailability never retries through the legacy index", async () => {
    await publish();
    const call = await start();
    const { skillRefusals } = await import("@/lib/skills");
    managedSearch.mockRejectedValueOnce(skillRefusals.unavailable());
    expect((await search(call.id, f.roleplay.slug)).status).toBe(503);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("unmapped managed activation with missing package artifacts fails 503 rather than creating a legacy call", async () => {
    await publish();
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { skill: "# Compatibility text is not a package" } } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id, agentId: f.roleplay.id } });
    await expect(start()).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("database freezes managed Agent/persona snapshots but permits real attachment updates", async () => {
    await publish();
    const call = await start();
    const row = await pinnedRow(call.id);
    const snapshot = row.compiledSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Expected compiled snapshot");
    for (const compiledSnapshot of [
      { ...snapshot, agent: { kind: "ROLEPLAY", primarySkillId: "wrong-skill", data: { artifacts: "wrong-package" } } },
      { ...snapshot, persona: { slug: "wrong-persona", version: 99, data: {} } },
      { documentManifests: [] },
    ]) {
      await expect(Promise.resolve(db.interviewSession.update({
        where: { id: call.id }, data: { compiledSnapshot },
      }))).rejects.toThrow();
    }
    expect((await pinnedRow(call.id)).compiledSnapshot).toEqual(snapshot);
    const document = await db.contextDocument.create({ data: {
      orgId: f.org.id, ownerUserId: f.trainer.id, name: "Buyer brief.pdf",
      mimeType: "application/pdf", kind: "document", size: 128, purpose: "during", manifest: { pageCount: 1 },
    } });
    const attachedSnapshot = {
      ...snapshot,
      sessionDocumentIds: [document.id],
      documentManifests: [{ id: document.id, name: document.name, kind: document.kind, mimeType: document.mimeType, size: document.size, pageCount: 1 }],
    };
    await db.$transaction([
      db.interviewSessionDocument.create({ data: { sessionId: call.id, documentId: document.id } }),
      db.interviewSession.update({ where: { id: call.id }, data: { compiledSnapshot: attachedSnapshot } }),
    ]);
    const attached = await pinnedRow(call.id);
    expect(attached.compiledSnapshot).toEqual(attachedSnapshot);
    expect(attached.skillPins).toEqual(row.skillPins);
    expect((await buildSessionContext({ orgId: f.org.id, sessionId: call.id })).documents).toEqual([
      expect.objectContaining({ id: document.id, name: document.name, pageCount: 1 }),
    ]);
    expect((await loadRoleplaySessionSkill(f.org.id, call.id))?.version.id).toBe(row.skillPins[0].skillVersionId);
  });

  test("explicit search role and step filters are preserved on the pinned path", async () => {
    const saved = await publish("authored");
    const call = await start(saved.slug);
    expect((await search(call.id, saved.slug, f.org.id, { role: "learner", step: "step-1" })).status).toBe(200);
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, expect.any(Array), "buyer concern", expect.objectContaining({
      role: "learner", step: "step-1", limit: 3,
    }));
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("a no-skill roleplay retains the legacy context and search path", async () => {
    const call = await start();
    const row = await pinnedRow(call.id);
    expect(row.skillPinsVersion).toBeNull();
    expect(row.skillPins).toEqual([]);
    await expect(Promise.resolve(db.interviewSession.update({
      where: { id: call.id }, data: { skillPinsVersion: 1 },
    }))).rejects.toThrow();
    expect(await loadRoleplaySessionSkill(f.org.id, call.id)).toBeNull();
    expect((await buildSessionContext({ orgId: f.org.id, sessionId: call.id })).agent?.data).toEqual({});
    expect((await search(call.id, f.roleplay.slug)).status).toBe(200);
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).toHaveBeenCalledWith(f.org.id, [{ slug: f.roleplay.slug, version: row.agentVersion }], "buyer concern", expect.objectContaining({ role: "trainer" }));
  });

  test("archiving the skill owner keeps existing pins and context usable", async () => {
    await publish();
    const call = await start();
    const before = await pinnedRow(call.id);
    await db.agent.update({ where: { id: f.roleplay.id }, data: { archivedAt: new Date() } });
    expect((await loadRoleplaySessionSkill(f.org.id, call.id))?.version.id).toBe(before.skillPins[0].skillVersionId);
    expect((await search(call.id, f.roleplay.slug)).status).toBe(200);
    await expect(start()).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect((await pinnedRow(call.id)).skillPins).toEqual(before.skillPins);
  });

  const managedData = (versionId: string, extra: Partial<Prisma.InterviewSessionUncheckedCreateInput> = {}) => ({
    orgId: f.org.id, userId: f.trainer.id, agentId: f.roleplay.id, shareCode: randomUUID(),
    personaSlug: f.org.slug, personaVersion: 1, agentSlug: f.roleplay.slug, agentVersion: 1,
    skillPinsVersion: 1,
    ...extra,
    skillPins: { create: { skillVersionId: versionId, alias: f.roleplay.slug, position: 0 } },
  });

  test.each(["wrong-org", "wrong-kind", "pending-version", "pending-index"] as const)("database rejects %s pin insert at the real transaction boundary", async (invalid) => {
    await publish();
    const call = await start();
    const first = (await pinnedRow(call.id)).skillPins[0].version;
    let versionId = first.id;
    if (invalid !== "wrong-org") {
      const format = invalid === "wrong-kind" ? "twin" : "builder-roleplay";
      const packageFiles = skillFiles(first.files);
      const version = await db.skillVersion.create({ data: {
        skillId: first.skillId, version: 99, format,
        status: invalid === "pending-version" ? "pending" : "ready",
        indexStatus: invalid === "pending-index" ? "pending" : "ready",
        contentHash: skillPackageHash(format, packageFiles), files: packageFiles,
        skillText: first.skillText, manifest: first.manifest ?? {}, itemCount: first.itemCount, artifacts: `${first.artifacts}/invalid`,
      } });
      versionId = version.id;
    }
    await expect(Promise.resolve(db.interviewSession.create({ data: managedData(versionId, invalid === "wrong-org" ? {
      orgId: other.org.id, userId: other.trainer.id, agentId: other.roleplay.id,
    } : {}) }))).rejects.toThrow();
  });

  test("database requires exactly one pin and prohibits marker, identity and pin mutations", async () => {
    await publish();
    const call = await start();
    const row = await pinnedRow(call.id);
    const pin = row.skillPins[0];
    const { skillPins: omitted, ...withoutPin } = managedData(pin.skillVersionId);
    expect(omitted.create.skillVersionId).toBe(pin.skillVersionId);
    await expect(Promise.resolve(db.interviewSession.create({ data: withoutPin }))).rejects.toThrow();
    for (const data of [
      { skillPinsVersion: null }, { skillPinsVersion: 2 }, { agentSlug: f.twin.slug }, { agentId: f.twin.id },
      { agentVersion: row.agentVersion + 1 }, { personaSlug: "different-persona" }, { personaVersion: row.personaVersion + 1 },
    ] satisfies Prisma.InterviewSessionUpdateInput[]) {
      await expect(Promise.resolve(db.interviewSession.update({ where: { id: call.id }, data }))).rejects.toThrow();
    }
    for (const data of [{ alias: "changed" }, { position: 1 }, { skillVersionId: randomUUID() }] satisfies Prisma.SessionSkillUncheckedUpdateInput[]) {
      await expect(Promise.resolve(db.sessionSkill.update({
        where: { sessionId_alias: { sessionId: call.id, alias: pin.alias } }, data,
      }))).rejects.toThrow();
    }
    await expect(Promise.resolve(db.sessionSkill.create({ data: {
      sessionId: call.id, orgId: f.org.id, skillVersionId: pin.skillVersionId, alias: "second-pin", position: 1,
    } }))).rejects.toThrow();
    await expect(Promise.resolve(db.sessionSkill.deleteMany({ where: { sessionId: call.id } }))).rejects.toThrow();
    expect((await pinnedRow(call.id)).skillPins).toEqual(row.skillPins);
    await db.interviewSession.delete({ where: { id: call.id } });
    expect(await db.sessionSkill.count({ where: { sessionId: call.id } })).toBe(0);
  });
});
