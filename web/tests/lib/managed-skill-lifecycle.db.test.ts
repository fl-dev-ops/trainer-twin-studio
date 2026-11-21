import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService, type ScenarioExample } from "@/lib/main-collection";
import * as knowledge from "@/lib/knowledge";
import * as ending from "@/lib/session-end";
import { activateSession } from "@/lib/interview-sessions";
import { buildSessionContext } from "@/lib/session-context";
import { activateSkillOwnership, disableCompatibilityIndex, skillOwnership } from "@/lib/skill-ownership";
import { checkSkillMigrationCoverage, migrateSkills } from "@/lib/skill-migration";
import { updateTwin } from "@/lib/twin/manage";
import { updateRoleplay } from "@/lib/roleplay/manage";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { runCopilotStudio } from "@/lib/copilot-studio";
import { listRunnableSpecs } from "@/lib/specs";
import { builtFrom } from "@/lib/skill-sources";
import type { RoleplayBuilder } from "@/lib/roleplay/skill";
import type { Prisma } from "@/lib/generated/prisma/client";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const canaryReference = "isolated-test-attestation-not-live";
const files = new Map<string, string>();
const indexes = new Map<string, ScenarioExample[]>();
const legacyIndexes = new Map<string, ScenarioExample[]>();
const s3 = await import("@/lib/s3");
const getObjectText = mock(async (key: string) => {
  const value = files.get(key);
  if (value === undefined) {
    const error = new Error(`Missing test object: ${key}`);
    error.name = "NoSuchKey";
    throw error;
  }
  return value;
});
mock.module("@/lib/s3", () => ({
  ...s3, s3Configured: true, getObjectText,
  putObject: mock(async (key: string, bytes: string) => { files.set(key, bytes); }),
}));
const { ingestTwinSkill, ingestScenario, saveRoleplay } = await import("@/lib/scenario-ingest");
const { POST } = await import("@/app/api/copilot/studio/route");
const formats = ["twin", "legacy-twin", "builder", "authored"] as const;
type Format = typeof formats[number];
const indexKey = (org: string, id: string, scope: string | number) => JSON.stringify([org, id, scope]);

describe.skipIf(!localMinutesDb)("managed skill ownership lifecycle (real Postgres, boundary-mocked canary)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let secret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  let managedSearch: ReturnType<typeof spyOn<typeof MainCollectionService, "searchSkillItems">>;
  let legacySearch: ReturnType<typeof spyOn<typeof MainCollectionService, "searchScenarioItems">>;
  let compatibilityWrite: ReturnType<typeof spyOn<typeof MainCollectionService, "writeScenarioItems">>;

  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create({ voice: true }); await other.create();
    files.clear(); indexes.clear(); legacyIndexes.clear(); getObjectText.mockClear();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "managed-lifecycle-test-secret";
    const fetch = globalThis.fetch;
    compatibilityWrite = spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (org, slug, scenario, version, items) => {
      legacyIndexes.set(indexKey(org, slug, version), items.map((item) => ({
        text: item.text, context: item.context, role: item.role, score: 0.9, scenario,
      })));
      return items.length;
    });
    spies.push(
      compatibilityWrite,
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (org, id, scenario, items, scope) => {
        indexes.set(indexKey(org, id, scope), items.map((item) => ({
          text: item.text, context: item.context, role: item.role, score: 0.9, scenario,
        })));
        return items.length;
      }),
      spyOn(MainCollectionService, "skillItemCount").mockImplementation(async (org, id, scope) =>
        indexes.get(indexKey(org, id, scope))?.length ?? 0),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
      spyOn(knowledge, "embedTexts").mockResolvedValue([[0.1, 0.2]]),
      spyOn(ending, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("meteroid.test")) return fetch(url, init);
        if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call: ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    managedSearch = spyOn(MainCollectionService, "searchSkillItems").mockImplementation(async (org, scopes, _query, options) =>
      scopes.flatMap((scope) => indexes.get(indexKey(org, scope.skillVersionId, scope.indexScope)) ?? [])
        .filter((item) => !options?.role || item.role === options.role).slice(0, options?.limit ?? 3));
    legacySearch = spyOn(MainCollectionService, "searchScenarioItems").mockImplementation(async (org, scopes, _query, options) =>
      scopes.flatMap((scope) => legacyIndexes.get(indexKey(org, scope.slug, scope.version ?? 1)) ?? [])
        .filter((item) => !options?.role || item.role === options.role).slice(0, options?.limit ?? 3));
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

  const actor = (fixture = f) => ({ org: fixture.org, user: fixture.trainer });
  const builder = (revision = 1): RoleplayBuilder => ({
    name: "Managed builder", persona: f.org.slug,
    situation: { scenario: `Concern v${revision}`, learnerRole: "Advisor" }, difficulty: "medium",
    opening: `Builder opening v${revision}`, exampleLines: [`Builder example v${revision}`],
    guardedIf: [], opensUpIf: [], learnerGoals: [`Goal v${revision}`],
    rubric: [{ name: `Rubric v${revision}`, points: 100 }],
  });
  const publish = (format: Format, revision = 1, source?: string) => {
    if (format === "builder") return saveRoleplay(f.org.id, builder(revision), f.roleplay.slug);
    const topic = format === "twin" ? "managed-twin" : format === "legacy-twin" ? "managed-scenario-twin" : "managed-authored";
    const items = [{ id: `line-${revision}`, role: "trainer" as const, context: "Opening",
      text: `${topic} example v${revision}`, metadata: { step: "opening", ...(source ? { source } : {}) } }];
    if (format === "twin") return ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill: `# ${topic} instructions v${revision}\n`,
      manifest: { skill: topic, name: topic, description: `Description v${revision}`, situations: [{ id: "opening", name: "Opening" }] },
      items,
    });
    return ingestScenario(f.org.id, {
      kind: format === "legacy-twin" ? "TWIN" : "ROLEPLAY", personaSlug: f.org.slug,
      skill: `# ${topic} instructions v${revision}\n`, items,
      scenario: { scenario: topic, name: topic, description: `Description v${revision}`,
        trainer_role: "Coach", learner_role: "Advisor",
        steps: [{ id: "opening", name: "Opening", trainer_moves: ["ask"], learner_moves: ["answer"] }] },
    });
  };
  const coverage = async (fixture = f) => {
    const report = await checkSkillMigrationCoverage(fixture.org.id, { batchSize: 1 });
    expect(report).toMatchObject({ complete: true, currentGaps: [], historicalGaps: [], requiredGaps: [] });
    expect(report.entries.every((entry) => entry.status === "verified")).toBe(true);
    return report;
  };
  const cutover = async (fixture = f) => {
    const migrated = await migrateSkills(fixture.org.id, { apply: true });
    expect(migrated).toMatchObject({ currentGaps: [], requiredGaps: [], historicalGaps: [] });
    const report = await coverage(fixture);
    return activateSkillOwnership(fixture.org.id, { apply: true, inventoryHash: report.hash, canaryReference });
  };
  const agent = (slug: string) => db.agent.findUniqueOrThrow({ where: { slug } });
  const sessionRow = (id: string) => db.interviewSession.findUniqueOrThrow({
    where: { id }, include: { skillPins: { include: { version: true }, orderBy: { position: "asc" } } },
  });
  const start = async (slug: string, format: Format | "main" = "twin") => {
    const session = await activateSession({
      orgId: f.org.id, userId: f.trainer.id, agentSlug: slug,
      mode: format === "builder" || format === "authored" ? "chat" : "voice", idempotencyKey: randomUUID(),
    });
    if (!session) throw new Error("Expected activated session");
    return session;
  };
  const context = (id: string, slug: string) => buildSessionContext({ orgId: f.org.id, sessionId: id, agentSlug: slug });
  const search = (sessionId: string, agentSlug: string, orgId = f.org.id) => POST(new Request("http://localhost/api/copilot/studio", {
    method: "POST", headers: { authorization: "Bearer managed-lifecycle-test-secret",
      "x-trainertwin-org-id": orgId, "content-type": "application/json" },
    body: JSON.stringify({ action: "searchScenarioItems", sessionId, agentSlug, query: "concern", limit: 3 }),
  }));
  const expectPackageFree = (data: Prisma.JsonValue) => {
    expect(data).not.toBeNull();
    for (const field of ["skill", "scenario", "artifacts", "filesHash"]) expect(data).not.toHaveProperty(field);
  };
  const expectNewHistoryPackageFree = async (slug: string, fromVersion = 0) => {
    const history = await db.specVersion.findMany({
      where: { orgId: f.org.id, entityType: "agents", entitySlug: slug, version: { gte: fromVersion } },
    });
    for (const row of history) expectPackageFree(row.data);
    return history;
  };

  test("compatibility defaults to no approval and cutover records the explicit isolated test attestation", async () => {
    expect(await skillOwnership(f.org.id)).toMatchObject({
      mode: "compatibility", approvedAt: null, verifiedAt: null, inventoryHash: null, canaryReference: null,
    });
    const saved = await publish("twin");
    expect((await agent(saved.slug)).data).toMatchObject({ skill: "# managed-twin instructions v1\n", artifacts: saved.artifacts });
    const before = await db.interviewSession.count({ where: { orgId: f.org.id } });
    const state = await cutover();
    expect(state).toMatchObject({ orgId: f.org.id, mode: "managed", canaryReference,
      approvedAt: expect.any(Date), verifiedAt: expect.any(Date) });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(before);
    expect((await skillOwnership(other.org.id)).mode).toBe("compatibility");
    await publish("twin", 2);
    expectPackageFree((await agent(saved.slug)).data);
    const fresh = await coverage();
    expect(await activateSkillOwnership(f.org.id, { apply: true, inventoryHash: fresh.hash, canaryReference })).toEqual(state);
    expect(await disableCompatibilityIndex(f.org.id)).toBe(false);
    expect(compatibilityWrite).toHaveBeenCalled();
  });

  test.each(formats)("%s publishes package-free current/history rows while public reads and v1 session pins survive v2/v3", async (format) => {
    await cutover();
    const saved = await publish(format);
    const owner = await agent(saved.slug);
    expectPackageFree(owner.data);
    const call = await start(saved.slug, format);
    const before = await sessionRow(call.id);
    const initialContext = await context(call.id, saved.slug);
    expect(before.skillPinsVersion).toBe(1);
    expect(before.skillPins).toHaveLength(1);
    const [pin] = before.skillPins;
    const originalPackage = await runCopilotStudio(actor(), { action: "getSkill", slug: saved.slug, version: owner.version });
    expect(originalPackage).toMatchObject({ version: owner.version, skill: pin.version.skillText });
    expect(await listRunnableSpecs("agents", f.org.id)).toContain(saved.slug);
    if (format === "builder") {
      const editor = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
      expect(await editor.builder.get({ slug: saved.slug })).toMatchObject({ builder: builder() });
    }
    const fields = ["skill", "scenario", "artifacts", "filesHash"];
    for (const revision of [2, 3]) {
      const published = await publish(format, revision);
      expectPackageFree((await agent(saved.slug)).data);
      const history = await expectNewHistoryPackageFree(saved.slug, owner.version);
      expect(history.length).toBe(revision - 1);
      getObjectText.mockClear();
      expect(await context(call.id, saved.slug)).toEqual(initialContext);
      const response = await search(call.id, saved.slug);
      expect(response.status).toBe(200);
      const body = await response.json();
      const originalExamples = (indexes.get(indexKey(f.org.id, pin.skillVersionId, pin.version.artifacts)) ?? [])
        .filter((item) => item.role === (format === "builder" ? "client" : "trainer")).slice(0, 3);
      expect(body).toMatchObject({ examples: originalExamples });
      expect(getObjectText).not.toHaveBeenCalled();
      expect(managedSearch).toHaveBeenLastCalledWith(f.org.id, [{
        skillVersionId: pin.skillVersionId, indexScope: pin.version.artifacts, itemCount: pin.version.itemCount,
      }], "concern", expect.objectContaining({ role: format === "builder" ? "client" : "trainer" }));
      expect(await runCopilotStudio(actor(), { action: "getSkill", slug: saved.slug, version: owner.version })).toMatchObject({
        version: owner.version, currentVersion: published.version, skill: pin.version.skillText,
      });
      const current = await runCopilotStudio(actor(), { action: "getSkill", slug: saved.slug });
      expect(current).toMatchObject({ version: published.version, currentVersion: published.version });
      for (const field of fields) expect((await agent(saved.slug)).data).not.toHaveProperty(field);
      await coverage();
    }
    expect((await sessionRow(call.id)).compiledSnapshot).toEqual(before.compiledSnapshot);
    expect((await sessionRow(call.id)).skillPins).toEqual(before.skillPins);
    expect(legacySearch).not.toHaveBeenCalled();
    const next = await start(saved.slug, format);
    const nextRow = await sessionRow(next.id);
    expect(nextRow.skillPins[0].version.version).toBe(3);
    expect((await context(next.id, saved.slug)).agent?.data).toMatchObject({ skill: nextRow.skillPins[0].version.skillText });
    expect(nextRow.skillPins[0].skillVersionId).not.toBe(pin.skillVersionId);
    const list = await runCopilotStudio(actor(), { action: "list" });
    expect(list).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ slug: saved.slug })]) });
    expect(compatibilityWrite).toHaveBeenCalledTimes(3);
    expect(await db.skillSource.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("a newly published skill after cutover remains covered and approval is idempotent only with a fresh inventory", async () => {
    const state = await cutover();
    const oldHash = (await coverage()).hash;
    const first = await publish("twin");
    const fresh = await coverage();
    expect(fresh.hash).not.toBe(oldHash);
    await expect(activateSkillOwnership(f.org.id, { apply: true, inventoryHash: oldHash, canaryReference })).rejects.toThrow("stale");
    expect(await activateSkillOwnership(f.org.id, { apply: true, inventoryHash: fresh.hash, canaryReference })).toEqual(state);
    const next = await publish("authored");
    await coverage();
    expectPackageFree((await agent(first.slug)).data);
    expectPackageFree((await agent(next.slug)).data);
  });

  test.each(formats)("%s compatibility history remains readable when approval switches subsequent writes to managed ownership", async (format) => {
    const first = await publish(format);
    const original = await agent(first.slug);
    const call = await start(first.slug, format);
    const originalContext = await context(call.id, first.slug);
    const second = await publish(format, 2);
    const oldHistory = await db.specVersion.findMany({
      where: { orgId: f.org.id, entitySlug: first.slug }, orderBy: { version: "asc" },
    });
    expect((await agent(first.slug)).data).toHaveProperty("skill");
    expect(oldHistory.some((row) => row.version === original.version)).toBe(true);
    await cutover();
    await publish(format, 3);
    expectPackageFree((await agent(first.slug)).data);
    expect(await db.specVersion.findMany({
      where: { orgId: f.org.id, entitySlug: first.slug, version: { lt: second.version } },
      orderBy: { version: "asc" },
    })).toEqual(oldHistory);
    expect(await expectNewHistoryPackageFree(first.slug, second.version)).toHaveLength(1);
    expect(await runCopilotStudio(actor(), { action: "getSkill", slug: first.slug, version: original.version })).toMatchObject({
      version: original.version,
      skill: (await sessionRow(call.id)).skillPins[0].version.skillText,
    });
    expect(await context(call.id, first.slug)).toEqual(originalContext);
    await coverage();
  });

  test.each(["apply", "canary", "hash", "stale", "coverage", "cross-org"] as const)("ownership approval refuses %s without changing either organization", async (invalid) => {
    await publish("twin");
    await migrateSkills(f.org.id, { apply: true });
    const report = await coverage();
    if (invalid === "coverage") {
      const saved = await agent(`${f.org.slug}-managed-twin`);
      await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id, agentId: saved.id } });
    }
    const orgId = invalid === "cross-org" ? other.org.id : f.org.id;
    await expect(activateSkillOwnership(orgId, {
      apply: invalid !== "apply", inventoryHash: invalid === "hash" ? "" : invalid === "stale" ? "stale-hash" : report.hash,
      canaryReference: invalid === "canary" ? "   " : canaryReference,
    })).rejects.toThrow();
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
    expect((await skillOwnership(other.org.id)).mode).toBe("compatibility");
  });

  test("the real ownership table rejects unsafe states and nonexistent organizations", async () => {
    await expect(Promise.resolve(db.$executeRaw`
      INSERT INTO "SkillOwnership" ("orgId", mode, "updatedAt") VALUES (${f.org.id}, 'unsupported', CURRENT_TIMESTAMP)
    `)).rejects.toThrow();
    await expect(Promise.resolve(db.$executeRaw`
      INSERT INTO "SkillOwnership" ("orgId", mode, "updatedAt") VALUES (${randomUUID()}, 'managed', CURRENT_TIMESTAMP)
    `)).rejects.toThrow();
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
  });

  test("managed twin settings carry mappings and source history without copying package fields back", async () => {
    await cutover();
    const kb = await db.knowledgeBase.create({ data: { orgId: f.org.id, slug: "source", name: "Source" } });
    const source = await db.knowledgeDocument.create({ data: {
      kbId: kb.id, slug: "advice", title: "Original advice", ext: "md", size: 10, s3SourceKey: "fixture/advice.md",
    } });
    const saved = await publish("twin", 1, source.id);
    const owner = await agent(saved.slug);
    const call = await start(saved.slug);
    const before = await sessionRow(call.id);
    const originalContext = await context(call.id, saved.slug);
    const changed = await updateTwin(f.org.id, saved.slug, {
      name: "Updated managed twin", description: "Updated coaching", settings: { preUpload: true },
    });
    const current = await agent(saved.slug);
    expect(current.version).toBe(changed.version);
    expectPackageFree(current.data);
    expect((await expectNewHistoryPackageFree(saved.slug))).toHaveLength(1);
    expect(await db.agentSkillVersion.findMany({ where: { agentId: owner.id }, orderBy: { agentVersion: "asc" } })).toEqual([
      expect.objectContaining({ agentVersion: owner.version, skillVersionId: before.skillPins[0].skillVersionId }),
      expect.objectContaining({ agentVersion: current.version, skillVersionId: before.skillPins[0].skillVersionId }),
    ]);
    expect(await db.skillVersionSource.findMany({ where: { orgId: f.org.id } })).toEqual([
      expect.objectContaining({ skillVersionId: before.skillPins[0].skillVersionId, documentId: source.id, title: source.title, items: 1 }),
    ]);
    expect(await builtFrom(f.org.id, [{ agentId: owner.id, version: current.version }])).toEqual([
      { documentId: source.id, title: source.title, items: 1, exists: true },
    ]);
    expect(await db.skillSource.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await context(call.id, saved.slug)).toEqual(originalContext);
    const next = await start(saved.slug);
    expect((await context(next.id, saved.slug)).agent?.data).toMatchObject({
      name: "Updated managed twin", objective: "Updated coaching", before: { preUpload: true },
      skill: before.skillPins[0].version.skillText,
    });
    await db.knowledgeDocument.delete({ where: { id: source.id } });
    expect(await builtFrom(f.org.id, [{ agentId: owner.id, version: current.version }])).toEqual([
      { documentId: source.id, title: source.title, items: 1, exists: false },
    ]);
    await coverage();
  });

  test.each(["builder", "authored"] as const)("%s settings use the mapped package and preserve raw package-free storage", async (format) => {
    await cutover();
    const saved = await publish(format);
    const owner = await agent(saved.slug);
    const call = await start(saved.slug, format);
    const before = await sessionRow(call.id);
    const initialContext = await context(call.id, saved.slug);
    await updateRoleplay(f.org.id, saved.slug, { before: { preUpload: true } });
    const current = await agent(saved.slug);
    expectPackageFree(current.data);
    expect(current.data).toMatchObject({ before: { preUpload: true } });
    await expectNewHistoryPackageFree(saved.slug);
    const mappings = await db.agentSkillVersion.findMany({ where: { agentId: owner.id } });
    expect(mappings.every((mapping) => mapping.skillVersionId === before.skillPins[0].skillVersionId)).toBe(true);
    expect(await db.skillVersion.count({ where: { skillId: before.skillPins[0].version.skillId } })).toBe(1);
    expect(await context(call.id, saved.slug)).toEqual(initialContext);
    expect(await runCopilotStudio(actor(), { action: "get", slug: saved.slug })).toMatchObject({ settings: { preUpload: true } });
    if (format === "builder") {
      const editor = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
      expect(await editor.builder.get({ slug: saved.slug })).toMatchObject({ builder: builder(), before: { preUpload: true } });
    }
    await coverage();
  });

  test.each([
    { field: "name", value: "" },
    { field: "difficulty", value: "unsupported" },
    { field: "opening", value: "" },
    { field: "situation", value: { scenario: "", learnerRole: "Advisor" } },
  ])("migration accepts scoring-free builder files but rejects malformed during.$field", async ({ field, value }) => {
    const saved = await publish("builder");
    const call = await start(saved.slug, "builder");
    const before = await sessionRow(call.id);
    const version = before.skillPins[0].version;
    const key = `${version.artifacts}/scenario.json`;
    const original = files.get(key);
    if (!original) throw new Error("Expected original builder manifest");
    const manifest: unknown = JSON.parse(original);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !("roleplay" in manifest)) {
      throw new Error("Expected builder manifest");
    }
    const during = manifest.roleplay;
    if (!during || typeof during !== "object" || Array.isArray(during)) throw new Error("Expected during fields");
    expect(during).not.toHaveProperty("learnerGoals");
    expect(during).not.toHaveProperty("rubric");
    expect(before.compiledSnapshot).toMatchObject({
      agent: { data: { after: { goals: ["Goal v1"], rubric: [{ name: "Rubric v1", points: 100 }] } } },
    });
    await coverage();
    files.set(key, JSON.stringify({ ...manifest, roleplay: { ...during, [field]: value } }));
    const report = await migrateSkills(f.org.id, { apply: true });
    const entry = report.entries.find((entry) => entry.slug === saved.slug && entry.agentVersion === saved.version);
    expect(entry).toMatchObject({ status: "failed" });
    expect(entry?.error).toContain("ZodError");
    expect(entry?.error).toContain(`"${field}"`);
    expect(report.currentGaps).toContain(`${saved.slug}@${saved.version}`);
    expect(await sessionRow(call.id)).toEqual(before);
    expect(await db.skillVersion.findUniqueOrThrow({ where: { id: version.id } })).toEqual(version);
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
    files.set(key, original);
    await coverage();
    await cutover();
    expect((await skillOwnership(f.org.id)).mode).toBe("managed");
    expect(await sessionRow(call.id)).toEqual(before);
  });

  test("cutover preserves an old mixed catalog and a frozen no-skill catalog while future main calls get managed skills", async () => {
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin", objective: "Coach" } } });
    const empty = await start(f.twin.slug, "main");
    const emptyBefore = await sessionRow(empty.id);
    const emptyContext = await context(empty.id, f.twin.slug);
    const saved = await publish("twin");
    const historical = await publish("legacy-twin");
    const legacyOwner = await agent(historical.slug);
    await db.agentSkillVersion.deleteMany({ where: { agentId: legacyOwner.id, orgId: f.org.id } });
    await db.agent.update({ where: { id: legacyOwner.id }, data: { primarySkillId: null } });
    const mixed = await start(f.twin.slug, "main");
    const mixedBefore = await sessionRow(mixed.id);
    expect(mixedBefore.skillPins).toHaveLength(1);
    const mixedContext = await context(mixed.id, f.twin.slug);
    expect(mixedContext.twinPlaybooks).toHaveLength(2);
    await cutover();
    await publish("twin", 2);
    await publish("legacy-twin", 2);
    expect(await context(empty.id, f.twin.slug)).toEqual(emptyContext);
    expect((await sessionRow(empty.id)).compiledSnapshot).toEqual(emptyBefore.compiledSnapshot);
    expect(await context(mixed.id, f.twin.slug)).toEqual(mixedContext);
    expect((await sessionRow(mixed.id)).compiledSnapshot).toEqual(mixedBefore.compiledSnapshot);
    const next = await start(f.twin.slug, "main");
    const nextRow = await sessionRow(next.id);
    expect(nextRow.skillPins).toHaveLength(2);
    expect(nextRow.skillPins.map((pin) => pin.alias).sort()).toEqual([saved.slug, historical.slug].sort());
    expect(nextRow.skillPins.every((pin) => pin.version.version === 2)).toBe(true);
    await coverage();
  });

  test("null-marker historical sessions retain their snapshot and explicit legacy retrieval after managed-only updates", async () => {
    const saved = await publish("authored");
    const activated = await start(saved.slug, "authored");
    const activatedRow = await sessionRow(activated.id);
    const snapshot = activatedRow.compiledSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Expected compiled snapshot");
    const historical = await f.session({
      agentId: activatedRow.agentId, agentSlug: saved.slug, agentVersion: activatedRow.agentVersion,
      personaSlug: activatedRow.personaSlug, personaVersion: activatedRow.personaVersion,
      compiledSnapshot: snapshot, skillPinsVersion: null,
    });
    const originalRow = await sessionRow(historical.id);
    const originalContext = await context(historical.id, saved.slug);
    await cutover();
    for (const revision of [2, 3]) {
      await publish("authored", revision);
      expectPackageFree((await agent(saved.slug)).data);
      expect(await sessionRow(historical.id)).toEqual(originalRow);
      expect(await context(historical.id, saved.slug)).toEqual(originalContext);
      const response = await search(historical.id, saved.slug);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ examples: [{ text: "managed-authored example v1" }] });
      expect(legacySearch).toHaveBeenLastCalledWith(f.org.id, [{ slug: saved.slug, version: saved.version }], "concern",
        expect.objectContaining({ role: "trainer" }));
      expect(managedSearch).not.toHaveBeenCalled();
      await expectNewHistoryPackageFree(saved.slug, saved.version);
      await coverage();
    }
    expect(originalRow.skillPinsVersion).toBeNull();
    expect(originalRow.skillPins).toEqual([]);
  });

  test("a valid zero-item managed package is distinct from an unavailable index", async () => {
    await cutover();
    const saved = await ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill: "# Empty examples are valid\n",
      manifest: { skill: "empty-examples", name: "Empty examples", description: "No examples",
        situations: [{ id: "opening", name: "Opening" }] },
      items: [],
    });
    const call = await start(saved.slug);
    const before = await sessionRow(call.id);
    expect(before.skillPins[0].version).toMatchObject({ itemCount: 0, indexStatus: "ready" });
    expect((await search(call.id, saved.slug)).status).toBe(200);
    expect(await (await search(call.id, saved.slug)).json()).toMatchObject({ examples: [] });
    await coverage();
    await db.skillVersion.update({ where: { id: before.skillPins[0].skillVersionId }, data: { indexStatus: "failed" } });
    await expect(start(saved.slug)).rejects.toMatchObject({ status: 503 });
    expect((await search(call.id, saved.slug)).status).toBe(503);
    await expect(context(call.id, saved.slug)).rejects.toMatchObject({ status: 503 });
    expect(await runCopilotStudio(actor(), { action: "getSkill", slug: saved.slug })).toMatchObject({
      skill: "# Empty examples are valid\n", items: [],
    });
    expectPackageFree((await agent(saved.slug)).data);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("copilot package history and session retrieval refuse another organization after ownership cutover", async () => {
    await cutover();
    const saved = await publish("twin");
    const call = await start(saved.slug);
    await expect(runCopilotStudio(actor(other), { action: "getSkill", slug: saved.slug })).rejects.toMatchObject({ status: 404 });
    await expect(buildSessionContext({ orgId: other.org.id, sessionId: call.id, agentSlug: saved.slug })).rejects.toMatchObject({ status: 404 });
    expect((await search(call.id, saved.slug, other.org.id)).status).toBe(404);
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
    expect((await skillOwnership(other.org.id)).mode).toBe("compatibility");
  });
});
