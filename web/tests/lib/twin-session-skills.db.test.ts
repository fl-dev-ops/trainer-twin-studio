import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService, type ScenarioExample } from "@/lib/main-collection";
import * as knowledge from "@/lib/knowledge";
import * as ending from "@/lib/session-end";
import * as jev from "@/lib/jev";
import { activateSession, authorizeRuntimeSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { buildSessionContext } from "@/lib/session-context";
import { twinRouter } from "@/lib/twin/trpc";
import { updateTwin } from "@/lib/twin/manage";
import { builtFrom } from "@/lib/skill-sources";
import { readAgentSkillVersion } from "@/lib/skill-history";
import { scoreCalibrationOnce } from "@/lib/twin/calibration-score";
import { endTwinSession } from "@/workflows/end-twin-session";
import { skillRefusals } from "@/lib/skills";
import { db, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";
const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
const readObject = mock(async (key: string) => {
  const body = files.get(key);
  if (body === undefined) throw new Error(`Missing test object: ${key}`);
  return body;
});
mock.module("@/lib/s3", () => ({
  ...s3,
  s3Configured: true,
  putObject: mock(async (key: string, body: string) => { files.set(key, body); }),
  getObjectText: readObject,
}));
const { ingestTwinSkill, ingestScenario } = await import("@/lib/scenario-ingest");
const { POST } = await import("@/app/api/copilot/studio/route");

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase)("Phase 3 twin skill pins (real Postgres)", () => {
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
    readObject.mockClear();
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "twin-session-skills-test-secret";
    const fetch = globalThis.fetch;
    spies.push(
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _id, _manifest, items) => items.length),
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _manifest, _version, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
      spyOn(ending, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("meteroid.test")) return fetch(url, init);
        if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call: ${url}`);
        return new Response(null, { status: 204 });
      }),
      spyOn(knowledge, "embedTexts").mockResolvedValue([[0.1, 0.2]]),
      spyOn(jev, "decide").mockResolvedValue({}),
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

  const publish = (topic = "follow-up", revision = 1, fixture = f, personaSlug = fixture.org.slug) =>
    ingestTwinSkill(fixture.org.id, {
      personaSlug,
      skill: `# ${topic} instructions v${revision}\nAsk before advising.\n`,
      manifest: {
        skill: topic, name: topic, description: `${topic} revision ${revision}`,
        situations: [{ id: `${topic}-opening`, name: `Opening ${revision}` }],
      },
      items: [{
        id: `${topic}-line-${revision}`, role: "trainer", context: "Opening",
        text: `${topic} example v${revision}`, metadata: { step: `${topic}-opening` },
      }],
    });
  const mainTwin = () => db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin" } } });
  const start = async (slug = f.twin.slug, calibrate = false, idempotencyKey = randomUUID()) => {
    const session = await activateSession({
      orgId: f.org.id, userId: f.trainer.id, agentSlug: slug, mode: "voice", calibrate, idempotencyKey,
    });
    if (!session) throw new Error("Activation returned no session");
    return session;
  };
  const row = (id: string) => db.interviewSession.findUniqueOrThrow({
    where: { id }, include: { skillPins: { include: { version: true }, orderBy: { position: "asc" } } },
  });
  const context = (sessionId: string, agentSlug = f.twin.slug, orgId = f.org.id) =>
    buildSessionContext({ orgId, sessionId, agentSlug });
  const search = (sessionId: string, agentSlug = f.twin.slug, extra: Record<string, unknown> = {}, orgId = f.org.id) =>
    POST(new Request("http://localhost/api/copilot/studio", {
      method: "POST",
      headers: {
        authorization: "Bearer twin-session-skills-test-secret",
        "x-trainertwin-org-id": orgId, "content-type": "application/json",
      },
      body: JSON.stringify({ action: "searchScenarioItems", sessionId, agentSlug, query: "follow up", limit: 3, ...extra }),
    }));
  const legacy = async () => {
    const persona = await db.persona.findFirstOrThrow({ where: { orgId: f.org.id, slug: f.org.slug } });
    return db.agent.create({ data: {
      orgId: f.org.id, personaId: persona.id, slug: `${f.org.slug}-legacy`, name: "Legacy", kind: "TWIN",
      version: 7, order: 1,
      data: { source: "scenario-ingest", skill: "# Legacy instructions v7", scenario: {
        scenario: "legacy", name: "Legacy", description: "Legacy skill",
        trainer_role: "Trainer", learner_role: "Learner",
        steps: [{ id: "legacy-opening", name: "Legacy opening", trainer_moves: ["ask"], learner_moves: ["answer"] }],
      } },
    } });
  };
  const scope = (pin: Awaited<ReturnType<typeof row>>["skillPins"][number]) => ({
    skillVersionId: pin.skillVersionId, indexScope: pin.version.artifacts, itemCount: pin.version.itemCount,
  });
  const example = (text: string): ScenarioExample => ({ text, context: "Opening", role: "trainer", score: 0.9, scenario: "follow-up" });

  test("single managed twin instructions, examples and reconnect authorization retain v1 after v2/v3 and archive", async () => {
    const saved = await publish();
    const call = await start(saved.slug);
    const before = await row(call.id);
    const original = await context(call.id, saved.slug);
    expect(before.skillPinsVersion).toBe(1);
    expect(before.skillPins).toHaveLength(1);
    const [pin] = before.skillPins;
    expect(pin).toMatchObject({ orgId: f.org.id, alias: saved.slug, position: 0 });
    expect(original.agent).toMatchObject({ kind: "TWIN", data: { skill: pin.version.skillText } });
    managedSearch.mockResolvedValue([example("follow-up example v1")]);
    for (const revision of [2, 3]) {
      await publish("follow-up", revision);
      readObject.mockClear();
      expect(await context(call.id, saved.slug)).toEqual(original);
      const response = await search(call.id, saved.slug);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ examples: [{ text: "follow-up example v1" }] });
      expect(managedSearch).toHaveBeenLastCalledWith(f.org.id, [scope(pin)], "follow up",
        expect.objectContaining({ role: "trainer", limit: 3 }));
      expect(await authorizeRuntimeSession(call.id, call.agentToken)).toMatchObject({ id: call.id });
      expect(readObject).not.toHaveBeenCalled();
    }
    await publish("third-topic");
    readObject.mockClear();
    await db.agent.update({ where: { slug: saved.slug }, data: { archivedAt: new Date() } });
    expect(await context(call.id, saved.slug)).toEqual(original);
    expect((await search(call.id, saved.slug)).status).toBe(200);
    expect((await row(call.id)).skillPins).toEqual(before.skillPins);
    expect((await row(call.id)).compiledSnapshot).toEqual(before.compiledSnapshot);
    await expect(start(saved.slug)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(legacySearch).not.toHaveBeenCalled();
    expect(readObject).not.toHaveBeenCalled();
  });

  test("main twin captures an ordered same-org/persona mixed catalog and only managed entries become SessionSkill rows", async () => {
    await mainTwin();
    const alpha = await publish("alpha");
    const beta = await publish("beta");
    const historical = await legacy();
    await db.agent.update({ where: { slug: alpha.slug }, data: { order: 0, name: "Z first" } });
    await db.agent.update({ where: { slug: beta.slug }, data: { order: 1, name: "A second" } });
    await publish("foreign", 1, other);
    const persona = await db.persona.create({ data: {
      orgId: f.org.id, slug: `${f.org.slug}-other`, name: "Other own persona", isOwn: true, data: {},
    } });
    await publish("other-persona", 1, f, persona.slug);
    const archived = await publish("archived");
    await db.agent.update({ where: { slug: archived.slug }, data: { archivedAt: new Date() } });
    const call = await start();
    const before = await row(call.id);
    expect(before.skillPinsVersion).toBe(1);
    expect(before.skillPins.map((pin) => [pin.alias, pin.position])).toEqual([[alpha.slug, 0], [beta.slug, 1]]);
    const alphaAgent = await db.agent.findUniqueOrThrow({ where: { slug: alpha.slug } });
    const betaAgent = await db.agent.findUniqueOrThrow({ where: { slug: beta.slug } });
    expect(before.compiledSnapshot).toMatchObject({ twinSkills: [
      { slug: alpha.slug, version: alphaAgent.version, skillVersionId: before.skillPins[0].skillVersionId },
      { slug: beta.slug, version: betaAgent.version, skillVersionId: before.skillPins[1].skillVersionId },
      { slug: historical.slug, version: 7 },
    ] });
    const snapshot = before.compiledSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Expected snapshot");
    expect(snapshot.twinSkills).toEqual([
      { slug: alpha.slug, version: alphaAgent.version, skillVersionId: before.skillPins[0].skillVersionId },
      { slug: beta.slug, version: betaAgent.version, skillVersionId: before.skillPins[1].skillVersionId },
      { slug: historical.slug, version: 7 },
    ]);
    expect((await context(call.id)).twinPlaybooks?.map((book) => book.slug)).toEqual([alpha.slug, beta.slug, historical.slug]);
  });

  test("main twin keeps original catalog and package instructions through publications, a third topic and archive; next call gets current catalog", async () => {
    await mainTwin();
    const alpha = await publish("alpha");
    const beta = await publish("beta");
    const call = await start();
    const before = await row(call.id);
    const original = await context(call.id);
    for (const revision of [2, 3]) {
      await publish("alpha", revision);
      await publish("beta", revision);
      readObject.mockClear();
      expect(await context(call.id)).toEqual(original);
      expect(readObject).not.toHaveBeenCalled();
    }
    const third = await publish("third");
    readObject.mockClear();
    await db.agent.update({ where: { slug: alpha.slug }, data: { archivedAt: new Date() } });
    expect(await context(call.id)).toEqual(original);
    expect((await search(call.id)).status).toBe(200);
    expect(managedSearch).toHaveBeenLastCalledWith(f.org.id, before.skillPins.map(scope), "follow up",
      expect.objectContaining({ role: "trainer" }));
    expect((await row(call.id)).skillPins).toEqual(before.skillPins);
    const next = await start();
    const current = await row(next.id);
    expect(current.skillPins.map((pin) => pin.alias)).toEqual([beta.slug, third.slug]);
    expect(current.skillPins.map((pin) => pin.version.version)).toEqual([3, 1]);
    expect((await context(next.id)).twinPlaybooks?.map((book) => book.skill)).toEqual([
      "# beta instructions v3\nAsk before advising.\n", "# third instructions v1\nAsk before advising.\n",
    ]);
    expect(legacySearch).not.toHaveBeenCalled();
    expect(readObject).not.toHaveBeenCalled();
  });

  test("a no-skill main twin has marker 1 and a frozen empty catalog after a skill is published", async () => {
    await mainTwin();
    const call = await start();
    const before = await row(call.id);
    expect(before.skillPinsVersion).toBe(1);
    expect(before.skillPins).toEqual([]);
    expect(before.compiledSnapshot).toMatchObject({ twinSkills: [] });
    const original = await context(call.id);
    await publish();
    expect(await context(call.id)).toEqual(original);
    const response = await search(call.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ examples: [] });
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
    expect((await row(call.id)).compiledSnapshot).toEqual(before.compiledSnapshot);
  });

  test("mixed retrieval partitions managed package scopes from legacy slug/version scopes, including per-topic lookups", async () => {
    await mainTwin();
    const saved = await publish();
    const historical = await legacy();
    const call = await start();
    const before = await row(call.id);
    managedSearch.mockResolvedValue([example("Managed v1")]);
    legacySearch.mockResolvedValue([example("Legacy v7")]);
    const response = await search(call.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ examples: expect.arrayContaining([
      expect.objectContaining({ text: "Managed v1" }), expect.objectContaining({ text: "Legacy v7" }),
    ]) });
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, [scope(before.skillPins[0])], "follow up",
      expect.objectContaining({ role: "trainer" }));
    expect(legacySearch).toHaveBeenCalledWith(f.org.id, [{ slug: historical.slug, version: 7 }], "follow up",
      expect.objectContaining({ role: "trainer" }));
    managedSearch.mockClear(); legacySearch.mockClear();
    expect((await search(call.id, f.twin.slug, { playbook: "follow-up", step: "follow-up-opening", role: "learner" })).status).toBe(200);
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, [scope(before.skillPins[0])], "follow up",
      expect.objectContaining({ step: "follow-up-opening", role: "learner" }));
    expect(legacySearch).not.toHaveBeenCalled();
    managedSearch.mockClear(); legacySearch.mockClear();
    expect((await search(call.id, f.twin.slug, { playbook: historical.slug })).status).toBe(200);
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).toHaveBeenCalledWith(f.org.id, [{ slug: historical.slug, version: 7 }], "follow up", expect.any(Object));
    expect(saved.slug).not.toBe(historical.slug);
  });

  test.each(["unknown", "wrong-org", "wrong-agent"] as const)("%s session refuses context and retrieval before either provider search", async (invalid) => {
    const saved = await publish();
    const call = await start(saved.slug);
    const sessionId = invalid === "unknown" ? randomUUID() : call.id;
    const orgId = invalid === "wrong-org" ? other.org.id : f.org.id;
    const slug = invalid === "wrong-agent" ? f.twin.slug : saved.slug;
    await expect(context(sessionId, slug, orgId)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect((await search(sessionId, slug, {}, orgId)).status).toBe(404);
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test.each(["pending", "failed"] as const)("a %s managed index refuses context, search and activation without falling back", async (indexStatus) => {
    await mainTwin();
    await publish();
    await legacy();
    const call = await start();
    const before = await row(call.id);
    await db.skillVersion.update({ where: { id: before.skillPins[0].skillVersionId }, data: { indexStatus } });
    await expect(context(call.id)).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect((await search(call.id)).status).toBe(503);
    await expect(start()).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  test("managed provider failure returns 503 and does not retry the same package as legacy", async () => {
    const saved = await publish();
    const call = await start(saved.slug);
    managedSearch.mockRejectedValueOnce(skillRefusals.unavailable());
    expect((await search(call.id, saved.slug)).status).toBe(503);
    expect(managedSearch).toHaveBeenCalledTimes(1);
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("a main session authorizes only captured skill aliases and keeps a managed miss empty", async () => {
    await mainTwin();
    const saved = await publish();
    const historical = await legacy();
    const call = await start();
    const before = await row(call.id);
    const late = await publish("late");
    expect((await search(call.id, saved.slug)).status).toBe(200);
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, [scope(before.skillPins[0])], "follow up", expect.any(Object));
    expect(legacySearch).not.toHaveBeenCalled();
    managedSearch.mockClear();
    expect((await search(call.id, historical.slug)).status).toBe(200);
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).toHaveBeenCalledWith(f.org.id, [{ slug: historical.slug, version: 7 }], "follow up", expect.any(Object));
    legacySearch.mockClear();
    expect((await search(call.id, late.slug)).status).toBe(404);
    expect(managedSearch).not.toHaveBeenCalled();
    expect(legacySearch).not.toHaveBeenCalled();
    expect((await row(call.id)).skillPins).toEqual(before.skillPins);
  });

  test("unmapped managed activation refuses broken artifacts instead of trusting compatibility text", async () => {
    const saved = await publish();
    const owner = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug } });
    const mapping = await db.agentSkillVersion.findUniqueOrThrow({
      where: { agentId_agentVersion: { agentId: owner.id, agentVersion: owner.version } },
    });
    await db.agent.update({ where: { slug: saved.slug }, data: { data: { skill: "# Not a published package" } } });
    await db.agentSkillVersion.delete({
      where: { agentId_agentVersion: { agentId: owner.id, agentVersion: owner.version } },
    });
    await expect(start(saved.slug)).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    await db.agentSkillVersion.create({ data: mapping });
    const call = await start(saved.slug);
    expect((await row(call.id)).skillPins[0].skillVersionId).toBe(mapping.skillVersionId);
    expect((await context(call.id, saved.slug)).agent?.data).toMatchObject({ skill: "# follow-up instructions v1\nAsk before advising.\n" });
  });

  test("mixed catalogs retain managed pin positions across intervening legacy entries", async () => {
    await mainTwin();
    const first = await publish("first");
    const historical = await legacy();
    const last = await publish("last");
    await db.agent.update({ where: { slug: first.slug }, data: { order: 0 } });
    await db.agent.update({ where: { slug: last.slug }, data: { order: 2 } });
    const call = await start();
    const before = await row(call.id);
    expect(before.skillPins.map((pin) => [pin.alias, pin.position])).toEqual([[first.slug, 0], [last.slug, 2]]);
    expect((await context(call.id)).twinPlaybooks?.map((book) => book.slug)).toEqual([first.slug, historical.slug, last.slug]);
    expect((await search(call.id)).status).toBe(200);
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, before.skillPins.map(scope), "follow up", expect.any(Object));
    expect(legacySearch).toHaveBeenCalledWith(f.org.id, [{ slug: historical.slug, version: 7 }], "follow up", expect.any(Object));
  });

  test.each(["alias", "position", "missing-pin", "wrong-org", "wrong-persona"] as const)(
    "database rejects a managed main catalog with %s pins at commit", async (invalid) => {
      await mainTwin();
      await publish();
      const call = await start();
      const before = await row(call.id);
      const snapshot = before.compiledSnapshot;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Expected snapshot");
      const pin = before.skillPins[0];
      let skillVersionId = pin.skillVersionId;
      if (invalid === "wrong-org") {
        const foreign = await publish("foreign", 1, other);
        const owner = await db.agent.findUniqueOrThrow({ where: { slug: foreign.slug }, include: { primarySkill: true } });
        if (!owner.primarySkill?.currentVersionId) throw new Error("Expected foreign package");
        skillVersionId = owner.primarySkill.currentVersionId;
      }
      if (invalid === "wrong-persona") {
        const persona = await db.persona.create({ data: {
          orgId: f.org.id, slug: `${f.org.slug}-different`, name: "Different own persona", isOwn: true, data: {},
        } });
        const saved = await publish("different", 1, f, persona.slug);
        const owner = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug }, include: { primarySkill: true } });
        if (!owner.primarySkill?.currentVersionId) throw new Error("Expected different-persona package");
        skillVersionId = owner.primarySkill.currentVersionId;
      }
      const alias = invalid === "alias" ? "wrong-alias" : pin.alias;
      await expect(Promise.resolve(db.interviewSession.create({ data: {
        orgId: f.org.id, userId: f.trainer.id, agentId: f.twin.id, mode: "voice", shareCode: randomUUID(),
        personaSlug: before.personaSlug, personaVersion: before.personaVersion,
        agentSlug: before.agentSlug, agentVersion: before.agentVersion, skillPinsVersion: 1,
        compiledSnapshot: { ...snapshot, twinSkills: [{ slug: pin.alias, version: 1, skillVersionId }] },
        ...(invalid === "missing-pin" ? {} : { skillPins: { create: {
          skillVersionId, alias, position: invalid === "position" ? 1 : 0,
        } } }),
      } }))).rejects.toThrow();
      expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
    },
  );

  test("scenario-shaped managed twins preserve legacy manifest instructions and trainer examples", async () => {
    const saved = await ingestScenario(f.org.id, {
      personaSlug: f.org.slug, kind: "TWIN", skill: "# Scenario-shaped twin\nAsk why.",
      scenario: {
        scenario: "scenario-twin", name: "Scenario twin", description: "Historical format",
        trainer_role: "Coach", learner_role: "Advisor",
        steps: [{ id: "opening", name: "Opening", trainer_moves: ["ask"], learner_moves: ["answer"] }],
      },
      items: [{ id: "one", role: "trainer", context: "Opening", text: "Why now?", metadata: { step: "opening" } }],
    });
    const call = await start(saved.slug);
    const before = await row(call.id);
    expect(before.skillPins).toHaveLength(1);
    expect((await context(call.id, saved.slug)).agent).toMatchObject({
      kind: "TWIN", data: { skill: "# Scenario-shaped twin\nAsk why.", scenario: { scenario: "scenario-twin", trainer_role: "Coach" } },
    });
    expect((await search(call.id, saved.slug)).status).toBe(200);
    expect(managedSearch).toHaveBeenCalledWith(f.org.id, [scope(before.skillPins[0])], "follow up",
      expect.objectContaining({ role: "trainer", steps: [{ id: "opening", name: "Opening", trainer_moves: ["ask"], learner_moves: ["answer"] }] }));
    expect(legacySearch).not.toHaveBeenCalled();
  });

  test("database freezes managed twin catalog, package pins and empty catalogs while allowing attachment metadata", async () => {
    await mainTwin();
    const saved = await publish();
    const call = await start();
    const before = await row(call.id);
    const snapshot = before.compiledSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Expected snapshot");
    for (const twinSkills of [[], [{ slug: saved.slug, version: 999 }], [
      { slug: saved.slug, version: 1, skillVersionId: randomUUID() },
    ]]) {
      await expect(Promise.resolve(db.interviewSession.update({
        where: { id: call.id }, data: { compiledSnapshot: { ...snapshot, twinSkills } },
      }))).rejects.toThrow();
    }
    const { twinSkills: omitted, ...withoutCatalog } = snapshot;
    expect(omitted).toBeDefined();
    await expect(Promise.resolve(db.interviewSession.update({
      where: { id: call.id }, data: { compiledSnapshot: withoutCatalog },
    }))).rejects.toThrow();
    for (const data of [{ alias: "different" }, { position: 4 }, { skillVersionId: randomUUID() }]) {
      await expect(Promise.resolve(db.sessionSkill.update({
        where: { sessionId_alias: { sessionId: call.id, alias: before.skillPins[0].alias } }, data,
      }))).rejects.toThrow();
    }
    await expect(Promise.resolve(db.sessionSkill.deleteMany({ where: { sessionId: call.id } }))).rejects.toThrow();
    await db.interviewSession.update({
      where: { id: call.id }, data: { compiledSnapshot: { ...snapshot, sessionDocumentIds: [], documentManifests: [] } },
    });
    expect((await row(call.id)).skillPins).toEqual(before.skillPins);
    await db.agent.update({ where: { slug: saved.slug }, data: { archivedAt: new Date() } });
    const empty = await start();
    const emptyRow = await row(empty.id);
    const emptySnapshot = emptyRow.compiledSnapshot;
    if (!emptySnapshot || typeof emptySnapshot !== "object" || Array.isArray(emptySnapshot)) throw new Error("Expected empty snapshot");
    await expect(Promise.resolve(db.interviewSession.update({
      where: { id: empty.id }, data: { compiledSnapshot: { ...emptySnapshot, twinSkills: [{ slug: saved.slug, version: 1 }] } },
    }))).rejects.toThrow();
    await db.interviewSession.delete({ where: { id: call.id } });
    expect(await db.sessionSkill.count({ where: { sessionId: call.id } })).toBe(0);
  });

  test("calibration ratings, transcript evidence, scoring and no-report behavior retain the activated package snapshot", async () => {
    const saved = await publish();
    const call = await start(saved.slug, true);
    if (!call.calibrationId) throw new Error("Expected calibration");
    const before = await row(call.id);
    const caller = twinRouter.createCaller({ user: {
      ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin",
    } });
    await caller.calibrations.rate({
      calibrationId: call.calibrationId, turnIndex: 1, question: "When should I follow up?",
      reply: "This evening.", rating: "off",
    });
    await publish("follow-up", 2);
    await publish("follow-up", 3);
    await finalizeInterviewSession({
      sessionId: call.id, requestedStatus: "completed",
      transcript: [{ role: "user", text: "When should I follow up?" }, { role: "trainer", text: "This evening." }],
      evidence: { transcriptFinal: true },
    });
    expect(await endTwinSession(call.id)).toEqual({ status: "ended", calibration: "scored" });
    expect(await scoreCalibrationOnce(call.id)).toBeNull();
    expect(await caller.calibrations.get({ id: call.calibrationId })).toMatchObject({
      sessionId: call.id, score: { turns: 1, off: 1 },
    });
    const after = await row(call.id);
    expect(after.compiledSnapshot).toEqual(before.compiledSnapshot);
    expect(after.skillPins).toEqual(before.skillPins);
    expect(after.evidence).toMatchObject({ transcriptFinal: true });
    expect(after.report).toBeNull();
    expect(after.reportStatus).toBe("none");
    expect(after.reportWorkflowRunId).toBeNull();
    expect((await context(call.id, saved.slug)).agent?.data).toMatchObject({ skill: before.skillPins[0].version.skillText });
  });

  test("starting a twin again remains a new call, even with the same idempotency key", async () => {
    const saved = await publish();
    const key = randomUUID();
    const first = await start(saved.slug, false, key);
    await publish("follow-up", 2);
    const second = await start(saved.slug, false, key);
    expect(second.id).not.toBe(first.id);
    expect((await row(first.id)).skillPins[0].version.version).toBe(1);
    expect((await row(second.id)).skillPins[0].version.version).toBe(2);
    expect((await row(first.id)).status).toBe("abandoned");
  });

  test.each(["ready", "failed"] as const)("twin settings edits retain package mappings and saved sources with a %s index", async (indexStatus) => {
    const kb = await db.knowledgeBase.create({ data: { orgId: f.org.id, slug: "source", name: "Source" } });
    const document = await db.knowledgeDocument.create({ data: {
      kbId: kb.id, slug: "follow-up", title: "Original follow-up source", ext: "md", size: 80, s3SourceKey: "fixture/source.md",
    } });
    const saved = await ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill: "# Sourced follow-up\nAsk before advising.\n",
      manifest: {
        skill: "sourced-follow-up", name: "Sourced follow-up", description: "Original description",
        situations: [{ id: "opening", name: "Opening" }],
      },
      items: [{ id: "line-1", role: "trainer", context: "Opening", text: "When would help?",
        metadata: { step: "opening", source: document.id } }],
    });
    const call = await start(saved.slug);
    const before = await row(call.id);
    const originalContext = await context(call.id, saved.slug);
    const owner = await db.agent.findUniqueOrThrow({ where: { slug: saved.slug } });
    const versionId = before.skillPins[0].skillVersionId;
    const originalSources = await db.skillVersionSource.findMany({ where: { skillVersionId: versionId } });
    expect(originalSources).toEqual([expect.objectContaining({
      orgId: f.org.id, documentId: document.id, title: document.title, items: 1,
    })]);
    if (indexStatus === "failed") {
      await db.skillVersion.update({ where: { id: versionId }, data: { indexStatus } });
    }
    const beforeSettings = await row(call.id);
    expect(beforeSettings.skillPins[0].version).toMatchObject({
      id: versionId, indexStatus, contentHash: before.skillPins[0].version.contentHash,
    });
    const writes = files.size;
    const changed = await updateTwin(f.org.id, saved.slug, {
      name: "Updated follow-up", description: "Updated coaching description", settings: { preUpload: true },
    });
    expect(changed).toEqual({ version: owner.version + 1, changed: true });
    expect(await db.agentSkillVersion.findMany({
      where: { agentId: owner.id }, orderBy: { agentVersion: "asc" },
    })).toEqual([
      expect.objectContaining({ orgId: f.org.id, agentVersion: owner.version, skillVersionId: versionId }),
      expect.objectContaining({ orgId: f.org.id, agentVersion: changed.version, skillVersionId: versionId }),
    ]);
    expect(await db.skillVersion.count({ where: { skillId: before.skillPins[0].version.skillId } })).toBe(1);
    expect(await db.skillVersionSource.findMany({ where: { skillVersionId: versionId } })).toEqual(originalSources);
    expect(await readAgentSkillVersion(f.org.id, owner.id, changed.version)).toMatchObject({ id: versionId, indexStatus });
    await db.knowledgeDocument.delete({ where: { id: document.id } });
    expect(await builtFrom(f.org.id, [{ agentId: owner.id, version: changed.version }])).toEqual([
      { documentId: document.id, title: document.title, items: 1, exists: false },
    ]);
    expect((await row(call.id)).compiledSnapshot).toEqual(before.compiledSnapshot);
    expect((await row(call.id)).skillPins).toEqual(beforeSettings.skillPins);
    expect(files.size).toBe(writes);
    if (indexStatus === "failed") {
      await expect(start(saved.slug)).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
      expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
    } else {
      expect(await context(call.id, saved.slug)).toEqual(originalContext);
      const next = await start(saved.slug);
      expect((await context(next.id, saved.slug)).agent).toMatchObject({
        version: changed.version,
        data: { name: "Updated follow-up", objective: "Updated coaching description", before: { preUpload: true },
          skill: before.skillPins[0].version.skillText },
      });
      expect((await row(next.id)).skillPins[0].skillVersionId).toBe(versionId);
    }
  });
});
