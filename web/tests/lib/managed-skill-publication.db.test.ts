import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as database from "@/lib/db";
import * as jev from "@/lib/jev";
import * as ending from "@/lib/session-end";
import { MainCollectionService } from "@/lib/main-collection";
import { activateSession } from "@/lib/interview-sessions";
import { buildSessionContext } from "@/lib/session-context";
import { loadSessionSkills } from "@/lib/session-skills";
import { readSpec, readVersion } from "@/lib/specs";
import { runCopilotStudio } from "@/lib/copilot-studio";
import { ownershipLock, packageFieldsOmitted } from "@/lib/skill-ownership";
import type { RoleplayBuilder } from "@/lib/roleplay/skill";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { giveCharacters } from "../setup/characters";

const files = new Map<string, string>();
let corruptRead = false;
let failIndex = false;
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3, s3Configured: true,
  putObject: async (key: string, body: string) => { files.set(key, body); },
  getObjectText: async (key: string) => {
    const bytes = files.get(key);
    if (bytes === undefined) throw new Error(`Missing test object ${key}`);
    return corruptRead && key.endsWith("/items.json") ? "corrupt bytes" : bytes;
  },
}));
const { ingestScenario, ingestTwinSkill, saveRoleplay } = await import("@/lib/scenario-ingest");
const { POST } = await import("@/app/api/copilot/studio/route");
type Format = "builder-roleplay" | "authored-roleplay" | "twin" | "legacy-twin";
const formats: Format[] = ["builder-roleplay", "authored-roleplay", "twin", "legacy-twin"];

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!localMinutesDb)("managed-only skill publication (real Postgres)", () => {
  let f: MinutesFixture;
  let documentId: string;
  let secret: string | undefined;
  const spies: { mockRestore(): void }[] = [];
  let legacyWrite: ReturnType<typeof spyOn<typeof MainCollectionService, "writeScenarioItems">>;
  let managedSearch: ReturnType<typeof spyOn<typeof MainCollectionService, "searchSkillItems">>;
  let legacySearch: ReturnType<typeof spyOn<typeof MainCollectionService, "searchScenarioItems">>;
  let prune: ReturnType<typeof spyOn<typeof MainCollectionService, "pruneScenarioItems">>;

  const mode = async (value: "compatibility" | "managed") => {
    await db.$executeRaw`
      INSERT INTO "SkillOwnership" ("orgId", mode, "inventoryHash", "canaryReference", "verifiedAt", "approvedAt")
      VALUES (${f.org.id}, ${value}, 'isolated-test-inventory', 'isolated-test-canary', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("orgId") DO UPDATE SET mode = EXCLUDED.mode`;
  };
  beforeEach(async () => {
    f = minutesFixture();
    await f.create({ voice: true });
    await mode("managed");
    files.clear(); corruptRead = false; failIndex = false;
    secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "managed-publication-test";
    legacyWrite = spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length);
    managedSearch = spyOn(MainCollectionService, "searchSkillItems").mockResolvedValue([]);
    legacySearch = spyOn(MainCollectionService, "searchScenarioItems").mockResolvedValue([]);
    const fetch = globalThis.fetch;
    prune = spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined);
    spies.push(legacyWrite, managedSearch, legacySearch,
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _id, _scenario, items) => {
        if (failIndex) throw new Error("Index provider interrupted");
        return items.length;
      }),
      prune,
      spyOn(jev, "decide").mockResolvedValue({}),
      spyOn(ending, "startSessionEnd").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("meteroid.test")) return fetch(url, init);
        if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    const kb = await db.knowledgeBase.create({ data: { orgId: f.org.id, slug: f.org.slug, name: "Skill evidence" } });
    const document = await db.knowledgeDocument.create({
      data: { kbId: kb.id, slug: "evidence", title: "Original evidence title", ext: "txt", size: 1, s3SourceKey: "isolated/evidence.txt" },
    });
    documentId = document.id;
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = secret;
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkill.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.skillVersionSource.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.knowledgeBase.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  const builder = (revision = 1): RoleplayBuilder => ({
    name: "Managed practice", persona: f.org.slug,
    situation: { scenario: `Concern ${revision}`, learnerRole: "Advisor" },
    difficulty: "medium", exampleLines: [`Example ${revision}`],
    learnerGoals: [`Goal ${revision}`], rubric: [{ name: "Understanding", points: 100 }],
  });
  const publish = (format: Format = "authored-roleplay", revision = 1) => {
    if (format === "builder-roleplay") return saveRoleplay(f.org.id, builder(revision), f.roleplay.slug);
    const items = [{
      id: `line-${revision}`, role: "trainer" as const, context: "Buyer hesitates", text: `Concern ${revision}`,
      metadata: { step: "explore", source: documentId },
    }];
    const skill = `# Managed skill ${revision}\n`;
    if (format === "twin") return ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill, patterns: "# Source evidence\n",
      manifest: { skill: "managed-twin", name: "Managed twin", description: "Buyer coaching", situations: [{ id: "explore", name: "Explore" }] },
      items,
    });
    return ingestScenario(f.org.id, {
      kind: format === "legacy-twin" ? "TWIN" : "ROLEPLAY", personaSlug: f.org.slug, skill, items, patterns: "# Source evidence\n",
      scenario: {
        scenario: "managed-scenario", name: "Managed scenario", description: "Explore hesitation",
        trainer_role: "Buyer", learner_role: "Advisor", steps: [{ id: "explore", name: "Explore", trainer_moves: ["answer"], learner_moves: ["ask"] }],
      },
    });
  };
  const agent = (slug: string) => db.agent.findUniqueOrThrow({ where: { slug } });
  const links = (agentId: string) => db.agentSkillVersion.findMany({ where: { agentId }, orderBy: { agentVersion: "asc" }, include: { version: true } });
  const noPackage = (data: unknown) => {
    for (const key of ["skill", "scenario", "artifacts", "filesHash"]) expect(data).not.toHaveProperty(key);
  };
  const actor = () => ({ org: f.org, user: f.trainer });
  const pauseFinalization = (slug: string) => {
    const entered = barrier(), release = barrier();
    const lock = database.withLock;
    let calls = 0;
    spies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      expect(keys).toEqual([ownershipLock(f.org.id), `agent:${slug}`]);
      if (++calls === 2) {
        entered.resolve();
        await release.promise;
      }
      return lock(keys, work, options);
    }));
    return { entered, release };
  };

  test.each(formats)("%s stores only experience fields, projects history and keeps no-ops stable", async format => {
    const first = await publish(format);
    const row = await agent(first.slug);
    const [original] = await links(row.id);
    noPackage(row.data);
    expect(row.data).toHaveProperty("objective");
    expect(original.version).toMatchObject({ format, status: "ready", indexStatus: "ready", artifacts: first.artifacts });
    const originalFiles = new Map(files);
    expect(await publish(format)).toMatchObject({ version: first.version, artifacts: first.artifacts });
    expect(await agent(first.slug)).toEqual(row);
    expect(await links(row.id)).toEqual([original]);
    expect(files).toEqual(originalFiles);
    const second = await publish(format, 2);
    noPackage((await agent(first.slug)).data);
    const versions = await links(row.id);
    expect(versions.map(link => link.agentVersion)).toEqual([first.version, second.version]);
    expect(versions[1].skillVersionId).not.toBe(original.skillVersionId);
    const history = await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id, entitySlug: first.slug, version: first.version } });
    noPackage(history.data);
    expect(history.data).toEqual(row.data);
    expect(await readVersion("agents", first.slug, first.version, f.org.id)).toMatchObject({
      data: { skill: original.version.skillText, scenario: original.version.manifest, artifacts: first.artifacts, filesHash: original.version.contentHash },
    });
    expect(await readSpec("agents", first.slug, f.org.id)).toMatchObject({
      doc: { skill: versions[1].version.skillText, scenario: versions[1].version.manifest, artifacts: second.artifacts },
    });
    expect(await runCopilotStudio(actor(), { action: "getSkill", slug: first.slug, version: first.version })).toMatchObject({
      version: first.version, currentVersion: second.version, skill: original.version.skillText, manifest: original.version.manifest,
    });
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(0);
    expect(legacyWrite).toHaveBeenCalledTimes(2);
    if (format !== "builder-roleplay") {
      expect(await db.skillVersionSource.findMany({ where: { orgId: f.org.id } })).toHaveLength(2);
    }
    for (const [key, bytes] of originalFiles) expect(files.get(key)).toBe(bytes);
  });

  test.each(formats)("%s keeps exact session pins and retrieval scopes through two package-free updates", async format => {
    const first = await publish(format);
    await giveCharacters({ slug: first.slug });
    const call = await activateSession({
      orgId: f.org.id, userId: f.trainer.id, agentSlug: first.slug,
      mode: format === "twin" || format === "legacy-twin" ? "voice" : "chat", idempotencyKey: randomUUID(),
    });
    if (!call) throw new Error("Missing activated session");
    const before = await loadSessionSkills(f.org.id, call.id, first.slug);
    if (!before) throw new Error("Missing managed session pins");
    const context = await buildSessionContext({ orgId: f.org.id, sessionId: call.id, agentSlug: first.slug });
    for (const revision of [2, 3]) {
      await publish(format, revision);
      noPackage((await agent(first.slug)).data);
      expect(await loadSessionSkills(f.org.id, call.id, first.slug)).toEqual(before);
      expect(await buildSessionContext({ orgId: f.org.id, sessionId: call.id, agentSlug: first.slug })).toEqual(context);
      const response = await POST(new Request("http://localhost/api/copilot/studio", {
        method: "POST",
        headers: { authorization: "Bearer managed-publication-test", "x-trainertwin-org-id": f.org.id, "content-type": "application/json" },
        body: JSON.stringify({ action: "searchScenarioItems", sessionId: call.id, agentSlug: first.slug, query: "buyer concern" }),
      }));
      expect(response.status).toBe(200);
      expect(managedSearch.mock.calls.at(-1)?.slice(0, 3)).toEqual([
        f.org.id, before.pins.map(({ version }) => ({ skillVersionId: version.id, indexScope: version.artifacts, itemCount: version.itemCount })), "buyer concern",
      ]);
      expect(legacySearch).not.toHaveBeenCalled();
    }
  });

  test("absent ownership state retains compatibility projections and provenance", async () => {
    await db.$executeRaw`DELETE FROM "SkillOwnership" WHERE "orgId" = ${f.org.id}`;
    const saved = await publish();
    const row = await agent(saved.slug);
    expect(row.data).toMatchObject({ skill: "# Managed skill 1\n", artifacts: saved.artifacts });
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(1);
  });

  test("first managed no-op compacts a compatibility row without changing its version or package", async () => {
    await mode("compatibility");
    const saved = await publish();
    const before = await agent(saved.slug);
    const originalLinks = await links(before.id);
    await mode("managed");
    await publish();
    const after = await agent(saved.slug);
    expect(after.version).toBe(before.version);
    expect(after.data).toEqual(packageFieldsOmitted(before.data as object));
    expect(await links(before.id)).toEqual(originalLinks);
    expect(await db.skillSource.count({ where: { agentId: before.id } })).toBe(1);
    expect(await publish()).toMatchObject({ version: saved.version });
    expect(await agent(saved.slug)).toEqual(after);
  });

  test("managed transition preserves an unmapped compatibility version before package-free history save", async () => {
    await mode("compatibility");
    const first = await publish();
    const old = await agent(first.slug);
    const [original] = await links(old.id);
    await db.agentSkillVersion.deleteMany({ where: { agentId: old.id } });
    await mode("managed");
    await publish("authored-roleplay", 2);
    const versions = await links(old.id);
    expect(versions[0]).toMatchObject({ agentVersion: old.version, skillVersionId: original.skillVersionId });
    const snapshot = await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id, entitySlug: old.slug, version: old.version } });
    noPackage(snapshot.data);
    expect(await db.skillSource.count({ where: { agentId: old.id } })).toBe(1);
  });

  test("unchanged archive restoration preserves version, settings and ready package", async () => {
    const first = await publish();
    const row = await agent(first.slug);
    const originalLinks = await links(row.id);
    await db.agent.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    expect(await publish()).toMatchObject({ version: first.version });
    expect(await agent(first.slug)).toMatchObject({ archivedAt: null, data: row.data });
    expect((await links(row.id)).map(({ agentVersion, skillVersionId }) => [agentVersion, skillVersionId])).toEqual(
      originalLinks.map(({ agentVersion, skillVersionId }) => [agentVersion, skillVersionId]),
    );
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(0);
  });

  test("scoring-only publication advances experience mapping but not immutable package", async () => {
    const first = await publish("builder-roleplay");
    const row = await agent(first.slug);
    const [original] = await links(row.id);
    await saveRoleplay(f.org.id, { ...builder(), learnerGoals: ["A different goal"], rubric: [{ name: "Listening", points: 80 }] }, row.slug);
    const current = await agent(row.slug);
    noPackage(current.data);
    expect(current.data).toMatchObject({ after: { goals: ["A different goal"] } });
    const versions = await links(row.id);
    expect(versions).toHaveLength(2);
    expect(versions.every(link => link.skillVersionId === original.skillVersionId)).toBe(true);
    expect(await db.skillVersion.count({ where: { skillId: row.primarySkillId! } })).toBe(1);
    expect(files.get(`${first.artifacts}/SKILL.md`)).toBe(original.version.skillText);
  });

  test.each(["corrupt-bytes", "index-failure"] as const)("%s refuses readiness, preserves prior publication and retries same package identity", async failure => {
    const first = await publish();
    const row = await agent(first.slug);
    const originalLinks = await links(row.id);
    corruptRead = failure === "corrupt-bytes"; failIndex = failure === "index-failure";
    await expect(publish("authored-roleplay", 2)).rejects.toThrow();
    expect(await agent(first.slug)).toEqual(row);
    expect(await links(row.id)).toEqual(originalLinks);
    const failed = await db.skillVersion.findFirstOrThrow({ where: { skillId: row.primarySkillId!, status: "failed" } });
    expect(failed.indexStatus).toBe("failed");
    expect(await db.agentSkillVersion.count({ where: { skillVersionId: failed.id } })).toBe(0);
    corruptRead = false; failIndex = false;
    const retry = await publish("authored-roleplay", 2);
    const versions = await links(row.id);
    expect(versions[1].skillVersionId).toBe(failed.id);
    expect(versions[1].version).toMatchObject({ status: "ready", indexStatus: "ready", version: failed.version, artifacts: retry.artifacts });
    noPackage((await agent(first.slug)).data);
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(0);
    expect(files.get(`${first.artifacts}/SKILL.md`)).toBe(originalLinks[0].version.skillText);
  });

  test("saved provenance titles survive document rename/deletion without legacy source writes", async () => {
    const first = await publish();
    const row = await agent(first.slug);
    const [original] = await links(row.id);
    await db.knowledgeDocument.update({ where: { id: documentId }, data: { title: "Renamed evidence" } });
    const persona = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-other`, name: "Other buyer", data: {} } });
    const current = await runCopilotStudio(actor(), { action: "getSkill", slug: row.slug });
    expect(current).toMatchObject({ skill: "# Managed skill 1\n" });
    await ingestScenario(f.org.id, {
      kind: "ROLEPLAY", personaSlug: persona.slug, skill: original.version.skillText,
      scenario: JSON.parse(files.get(`${first.artifacts}/scenario.json`)!),
      items: JSON.parse(files.get(`${first.artifacts}/items.json`)!), patterns: "# Source evidence\n",
    });
    await db.knowledgeDocument.delete({ where: { id: documentId } });
    expect(await db.skillVersionSource.findMany({ where: { skillVersionId: original.skillVersionId } })).toMatchObject([
      { documentId, title: "Original evidence title", items: 1 },
    ]);
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(0);
  });

  test("publication detects raw settings changes rather than comparing hydrated copies for CAS", async () => {
    const first = await publish();
    const row = await agent(first.slug);
    const pause = pauseFinalization(row.slug);
    const pending = publish("authored-roleplay", 2);
    await pause.entered.promise;
    await db.agent.update({ where: { id: row.id }, data: { data: { ...packageFieldsOmitted(row.data as object), before: { preUpload: true } } } });
    pause.release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "skill_publication_superseded" });
    const after = await agent(row.slug);
    noPackage(after.data);
    expect(after.data).toMatchObject({ before: { preUpload: true } });
    expect((await links(row.id)).map(link => link.agentVersion)).toEqual([first.version]);
  });

  test("finalization honors managed ownership enabled after compatibility reservation", async () => {
    await mode("compatibility");
    const first = await publish();
    const before = await agent(first.slug);
    const pause = pauseFinalization(first.slug);
    const pending = publish("authored-roleplay", 2);
    await pause.entered.promise;
    await mode("managed");
    expect(await publish()).toMatchObject({ version: first.version });
    expect(await agent(first.slug)).toEqual(before);
    pause.release.resolve();
    await pending;
    const row = await agent(first.slug);
    noPackage(row.data);
    const history = await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id, entitySlug: first.slug, version: first.version } });
    noPackage(history.data);
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(1);
  });

  test("identical concurrent publication shares one package and idempotent finalization", async () => {
    const first = await publish();
    const row = await agent(first.slug);
    const pause = pauseFinalization(first.slug);
    const pending = publish("authored-roleplay", 2);
    await pause.entered.promise;
    const duplicate = await publish("authored-roleplay", 2);
    pause.release.resolve();
    expect(await pending).toMatchObject({ version: duplicate.version, artifacts: duplicate.artifacts });
    expect(await links(row.id)).toHaveLength(2);
    expect(await db.skillVersion.count({ where: { skillId: row.primarySkillId! } })).toBe(2);
    expect(await db.skillSource.count({ where: { agentId: row.id } })).toBe(0);
    noPackage((await agent(row.slug)).data);
  });

  test("ready no-op leaves another pending generation and captured raw Agent unchanged", async () => {
    const first = await publish();
    const row = await agent(first.slug);
    const pause = pauseFinalization(first.slug);
    const pending = publish("authored-roleplay", 2);
    await pause.entered.promise;
    const before = await db.skill.findUniqueOrThrow({ where: { id: row.primarySkillId! } });
    expect(await publish()).toMatchObject({ version: first.version, artifacts: first.artifacts });
    expect(await agent(first.slug)).toEqual(row);
    expect(await db.skill.findUniqueOrThrow({ where: { id: row.primarySkillId! } })).toEqual(before);
    pause.release.resolve();
    await pending;
    expect(await links(row.id)).toHaveLength(2);
  });

  test("new packages preserve unavailable previous index history while no-op cannot assert index readiness", async () => {
    const first = await publish();
    const row = await agent(first.slug);
    const [original] = await links(row.id);
    await db.skillVersion.update({ where: { id: original.skillVersionId }, data: { indexStatus: "failed", failure: "Rebuild required" } });
    await expect(publish()).rejects.toMatchObject({ code: "skill_package_unavailable" });
    await publish("authored-roleplay", 2);
    const versions = await links(row.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toMatchObject({ status: "ready", indexStatus: "failed", contentHash: original.version.contentHash });
    expect(versions[1].version.indexStatus).toBe("ready");
    noPackage((await agent(first.slug)).data);
  });

  test("publication attaches new topics to a merged twin but never re-adds a removed topic on edit", async () => {
    const first = await agent((await publish("twin")).slug);
    await db.agent.update({ where: { id: f.twin.id }, data: { data: { source: "twin" } } });
    await db.agentSkill.create({ data: { agentId: f.twin.id, orgId: f.org.id, skillId: first.primarySkillId!, position: 1, active: false } });
    const extra = (skill: string) => ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill,
      manifest: { skill: "another-topic", name: "Another topic", description: "Follow-ups", situations: [{ id: "explore", name: "Explore" }] },
      items: [],
    });
    const created = await extra("# New topic\n");
    const topic = await agent(created.slug);
    const read = () => db.agentSkill.findMany({ where: { agentId: f.twin.id }, orderBy: { position: "asc" }, select: { active: true, skillId: true } });
    expect(await read()).toEqual([{ active: false, skillId: first.primarySkillId! }, { active: true, skillId: topic.primarySkillId! }]);
    await db.agentSkill.deleteMany({ where: { agentId: f.twin.id, skillId: topic.primarySkillId! } });
    expect((await extra("# Revised topic\n")).created).toBe(false);
    expect(await read()).toEqual([{ active: false, skillId: first.primarySkillId! }]);
  });

  test("zero examples and provenance-only changes preserve the package identity contract", async () => {
    const saved = await ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill: "# Empty skill\n",
      manifest: { skill: "empty", name: "Empty", description: "No examples", situations: [] }, items: [],
      patterns: "", changes: { reason: "initial" },
    });
    const row = await agent(saved.slug);
    const [original] = await links(row.id);
    const beforeFiles = new Map(files);
    expect(original.version).toMatchObject({ itemCount: 0, status: "ready", indexStatus: "ready" });
    expect(files.get(`${saved.artifacts}/changes.json`)).toContain("initial");
    await ingestTwinSkill(f.org.id, {
      personaSlug: f.org.slug, skill: "# Empty skill\n",
      manifest: { skill: "empty", name: "Empty", description: "No examples", situations: [] }, items: [],
      patterns: "", changes: { reason: "provenance only" },
    });
    expect(await agent(row.slug)).toEqual(row);
    expect(await links(row.id)).toEqual([original]);
    expect(files).toEqual(beforeFiles);
    noPackage(row.data);
  });

  test("reservation, failing finalization and failure bookkeeping all take ownership lock first", async () => {
    const lock = database.withLock;
    const keysSeen: string[][] = [];
    spies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      keysSeen.push(keys);
      return lock(keys, work, options);
    }));
    failIndex = true;
    await expect(publish()).rejects.toThrow("Index provider interrupted");
    expect(keysSeen).toHaveLength(3);
    for (const keys of keysSeen) expect(keys).toEqual([ownershipLock(f.org.id), `agent:${f.org.slug}-managed-scenario`]);
    expect(await db.agentSkillVersion.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("managed and compatibility publication retain indexes until explicit audited retirement", async () => {
    const retained = new Set<number>();
    legacyWrite.mockImplementation(async (_org, _slug, _scenario, version, items) => {
      retained.add(version);
      return items.length;
    });
    prune.mockImplementation(async (_org, _slug, keepFrom) => {
      for (const version of retained) if (version < keepFrom) retained.delete(version);
    });
    const first = await publish();
    const second = await publish("authored-roleplay", 2);
    const third = await publish("authored-roleplay", 3);
    expect([...retained]).toEqual([first.version, second.version, third.version]);
    expect(prune).not.toHaveBeenCalled();
    await mode("compatibility");
    const fourth = await publish("authored-roleplay", 4);
    expect(prune).not.toHaveBeenCalled();
    expect([...retained]).toEqual([first.version, second.version, third.version, fourth.version]);
  });
});
