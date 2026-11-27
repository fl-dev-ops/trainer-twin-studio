import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import * as org from "@/lib/org";
import * as database from "@/lib/db";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Real Postgres and advisory locks; only files, embeddings and the model boundary are replaced.
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
const { saveRoleplay, ROLEPLAY_SOURCE } = await import("@/lib/scenario-ingest");
const { saveSpec } = await import("@/lib/specs");
const { roleplayRouter } = await import("@/lib/roleplay/trpc");
const { updateRoleplay } = await import("@/lib/roleplay/manage");
const rawBuilder: unknown = JSON.parse(readFileSync(new URL("../../data/roleplay/skills/wait-and-see-investor/builder.json", import.meta.url), "utf8"));
const before = { preScreenshare: false, preUpload: true, duringUpload: false, uploadTitle: "Notes", uploadInstruction: "Bring notes" };

describe.skipIf(!localMinutesDb)("Module 4 role-play saves (real Postgres locks)", () => {
  let f: MinutesFixture; let other: MinutesFixture;
  const spies: { mockRestore(): void }[] = [];
  const items = new Map<number, unknown[]>();
  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture(); await f.create(); await other.create(); files.clear(); items.clear();
    spies.push(spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _version, _scenario, input) => input.length), spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, version, input) => { items.set(version, input); return input.length; }), spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined), spyOn(org, "studioOrRefusal").mockResolvedValue({ ...f.org, accentColor: null, role: "admin", user: f.trainer }));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    for (const fixture of [other, f]) {
      await db.agent.updateMany({ where: { orgId: fixture.org.id }, data: { primarySkillId: null } });
      await db.skill.updateMany({ where: { orgId: fixture.org.id }, data: { currentVersionId: null } });
      await db.agentSkillVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skillVersionSource.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skillVersion.deleteMany({ where: { skill: { orgId: fixture.org.id } } });
      await db.skill.deleteMany({ where: { orgId: fixture.org.id } });
      await db.specDraft.deleteMany({ where: { orgId: fixture.org.id } });
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
  });
  // Each distinct learner brief is a distinct stage, so a new version.
  const builder = (whatToExpect = "Hello?") => {
    const raw = rawBuilder as Record<string, unknown>;
    return { ...raw, persona: f.org.slug, whatToExpect, exampleLines: [...(raw.exampleLines as string[] ?? []), whatToExpect] };
  };
  const caller = () => roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const row = () => db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
  const versions = () => db.specVersion.findMany({ where: { orgId: f.org.id, entitySlug: f.roleplay.slug }, orderBy: { version: "asc" } });

  test("intro video uploads are size-limited, scoped to the role play, and survive settings and script saves", async () => {
    await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    await saveRoleplay(other.org.id, { ...builder(), persona: other.org.slug }, other.roleplay.slug);
    const slug = f.roleplay.slug;
    const url = "https://example.com/put";
    const sign = spyOn(s3, "presignedPutUrl").mockResolvedValue(url);
    const verify = spyOn(s3, "isUploadedMp4").mockResolvedValue(false);
    spies.push(sign, verify);
    await expect(caller().builder.introVideoUploadUrl({ slug, size: 100 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().builder.introVideoUploadUrl({ slug: other.roleplay.slug, size: 32 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const upload = await caller().builder.introVideoUploadUrl({ slug, size: 32 });
    expect(upload.url).toBe(url);
    const key = s3.roleplayIntroKey(f.org.id, f.roleplay.id, upload.uploadId);
    expect(sign).toHaveBeenCalledWith(key, "video/mp4", 600, 32);
    await expect(caller().builder.saveIntroVideo({ slug, uploadId: upload.uploadId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    verify.mockImplementation(async (uploadedKey) => uploadedKey === key);
    await caller().builder.saveIntroVideo({ slug, uploadId: upload.uploadId });
    await caller().builder.saveSettings({ slug, before });
    await saveRoleplay(f.org.id, builder("Republish the script"), slug);
    expect(await row()).toMatchObject({ data: { introVideoUpload: upload.uploadId } });
    const signGet = spyOn(s3, "presignedGetUrl").mockResolvedValue("https://example.com/intro.mp4");
    spies.push(signGet);
    const { listScenarioIntroVideos } = await import("@/lib/specs");
    expect(await listScenarioIntroVideos(f.org.id, [slug])).toEqual({ [slug]: "https://example.com/intro.mp4" });
    expect(signGet).toHaveBeenCalledWith(key);
    expect((await caller().builder.get({ slug })).introVideoUrl).toBe("https://example.com/intro.mp4");
    await caller().builder.saveIntroVideo({ slug, uploadId: null });
    expect(await listScenarioIntroVideos(f.org.id, [slug])).toEqual({ [slug]: null });
    expect((await caller().builder.get({ slug })).introVideoUrl).toBeNull();
  });

  test("saved HTTPS links continue to work for role plays created before the uploader", async () => {
    await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const slug = f.roleplay.slug;
    const introVideoUrl = "https://example.com/intro.mp4";
    await expect(caller().builder.saveSettings({ slug, before: { ...before, introVideoUrl: "http://example.com/intro.mp4" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().builder.saveSettings({ slug, before: { ...before, introVideoUrl } });
    await caller().builder.saveSettings({ slug, before: { ...before, preScreenshare: true } });
    expect((await caller().builder.get({ slug })).before).toMatchObject({ introVideoUrl, preScreenshare: true });
    await caller().builder.saveSettings({ slug, before: { ...before, introVideoUrl: null } });
    expect((await caller().builder.get({ slug })).before.introVideoUrl).toBeNull();
  });

  test("two concurrent identical storeSkillAgent saves bump once; files, examples and row agree on the version", async () => {
    const first = await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const previousFiles = new Map(files); const previousVersion = first.version;
    const results = await Promise.all([saveRoleplay(f.org.id, builder("New script"), f.roleplay.slug), saveRoleplay(f.org.id, builder("New script"), f.roleplay.slug)]);
    expect(results.map((saved) => saved.version)).toEqual([previousVersion + 1, previousVersion + 1]);
    expect((await versions()).map((version) => version.version)).toEqual([1, previousVersion]);
    const current = await row(); const data = current.data as Record<string, unknown>;
    expect(current.version).toBe(previousVersion + 1); expect(data.artifacts).toBe(results[0].artifacts);
    expect(files.get(`${data.artifacts}/SKILL.md`)).toBe(data.skill);
    expect(JSON.parse(files.get(`${data.artifacts}/scenario.json`)!)).toEqual(data.scenario);
    expect(JSON.parse(files.get(`${data.artifacts}/items.json`)!)).toEqual(items.get(current.version));
    for (const [key, text] of previousFiles) expect(files.get(key)).toBe(text);
  });

  test("two approved Copilot changes keep both builder settings without republishing the script", async () => {
    const original = await saveRoleplay(f.org.id, builder("Keep this script"), f.roleplay.slug, before);
    const originalFiles = new Map(files);
    const lock = database.withLock;
    let ready!: () => void;
    const bothWaiting = new Promise<void>((resolve) => { ready = resolve; });
    let requests = 0;
    spies.push(spyOn(database, "withLock").mockImplementation((keys, work, options) => {
      if (++requests === 2) ready();
      return lock(keys, work, options);
    }));
    const patch = { orgId: f.org.id, slug: f.roleplay.slug };
    const keys = [`skill-ownership:${patch.orgId}`, `agent:${patch.slug}`];
    let updates!: Promise<PromiseSettledResult<unknown>[]>;
    await lock(keys, async () => {
      updates = Promise.allSettled([
        updateRoleplay(patch.orgId, patch.slug, { before: { preScreenshare: true } }),
        updateRoleplay(patch.orgId, patch.slug, { tools: { preview: true } }),
      ]);
      await bothWaiting;
    });
    expect((await updates).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await row()).toMatchObject({ version: original.version, data: {
      before: { ...before, preScreenshare: true }, tools: { preview: true }, skill: expect.stringContaining("Keep this script"),
    } });
    expect(files).toEqual(originalFiles);
  });

  test("settings changed during builder publication are preserved by refusal and explicit retry", async () => {
    const original = await saveRoleplay(f.org.id, builder("Old script"), f.roleplay.slug);
    let entered!: () => void; let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const lock = database.withLock;
    let calls = 0;
    spies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      expect(keys).toEqual([`skill-ownership:${f.org.id}`, `agent:${f.roleplay.slug}`]);
      if (++calls === 2) { entered(); await proceed; }
      return lock(keys, work, options);
    }));
    const save = Promise.allSettled([saveRoleplay(f.org.id, builder("New script"), f.roleplay.slug)]);
    try {
      await writing;
      expect(await caller().builder.saveSettings({ slug: f.roleplay.slug, before })).toEqual({ ok: true });
      expect(await row()).toMatchObject({ version: original.version, data: { before, skill: expect.stringContaining("Old script") } });
    } finally {
      release();
    }
    const [outcome] = await save;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      const error: unknown = outcome.reason;
      expect(error).toMatchObject({ code: "skill_publication_superseded", status: 409 });
    }
    const skill = await db.skill.findUniqueOrThrow({ where: { orgId_ownerSlug: { orgId: f.org.id, ownerSlug: f.roleplay.slug } }, include: { versions: { orderBy: { version: "desc" } } } });
    const failed = skill.versions[0];
    expect(failed.status).toBe("failed");
    const retry = await saveRoleplay(f.org.id, builder("New script"), f.roleplay.slug);
    const current = await row(); expect(current.version).toBe(retry.version); expect(current.version).toBeGreaterThan(original.version);
    expect((await db.skill.findUniqueOrThrow({ where: { id: skill.id } })).currentVersionId).toBe(failed.id);
    expect(await db.skillVersion.count({ where: { skillId: skill.id } })).toBe(2);
    expect(current.data).toMatchObject({ before, source: ROLEPLAY_SOURCE });
    expect((current.data as Record<string, unknown>).skill).toContain("New script");
    expect((current.data as Record<string, unknown>).skill).not.toContain("Old script");
    expect((await versions()).map((version) => version.version)).toEqual([1, original.version]);
  });

  test("refuses not_found when a role play is archived after saveSettings reads it but before its locked write", async () => {
    await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const lock = database.withLock;
    spies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      expect(keys).toEqual([`skill-ownership:${f.org.id}`, `agent:${f.roleplay.slug}`]);
      await db.agent.update({ where: { id: f.roleplay.id }, data: { archivedAt: new Date() } });
      return lock(keys, work, options);
    }));
    const beforeRow = await row();
    await expect(caller().builder.saveSettings({ slug: f.roleplay.slug, before })).rejects.toMatchObject({ code: "NOT_FOUND", cause: { code: "not_found", status: 404 } });
    const after = await row(); expect(after.data).toEqual(beforeRow.data); expect(after.version).toBe(beforeRow.version); expect(after.archivedAt).not.toBeNull();
  });

  test("settings cannot mutate Agent data or collide with the scenario namespace while final publication writes providers under lock", async () => {
    const original = await saveRoleplay(f.org.id, builder("Old script"), f.roleplay.slug);
    const oldItems = items.get(original.version);
    let entered!: () => void; let release!: () => void; let attempted!: () => void;
    const indexing = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const settingsRequested = new Promise<void>((resolve) => { attempted = resolve; });
    let pendingVersion = 0; let settingsEntered = false;
    spies.push(spyOn(MainCollectionService, "writeScenarioItems").mockImplementationOnce(async (_org, _slug, _scenario, version, input) => {
      pendingVersion = version; items.set(version, input);
      entered(); await proceed; return input.length;
    }));
    const publish = Promise.allSettled([saveRoleplay(f.org.id, builder("New script"), f.roleplay.slug)]);
    let settings: ReturnType<ReturnType<typeof caller>["builder"]["saveSettings"]> | undefined;
    try {
      await indexing;
      const lock = database.withLock;
      spies.push(spyOn(database, "withLock").mockImplementation((keys, work, options) => {
        expect(keys).toEqual([`skill-ownership:${f.org.id}`, `agent:${f.roleplay.slug}`]); attempted();
        return lock(keys, async (tx) => { settingsEntered = true; return work(tx); }, options);
      }));
      settings = caller().builder.saveSettings({ slug: f.roleplay.slug, before });
      await settingsRequested;
      expect(settingsEntered).toBe(false);
      expect(await row()).toMatchObject({ version: original.version, data: { skill: expect.stringContaining("Old script"), artifacts: original.artifacts } });
      expect(pendingVersion).toBeGreaterThan(original.version);
      expect(items.get(original.version)).toEqual(oldItems);
      expect(items.get(pendingVersion)).toEqual(expect.arrayContaining([expect.objectContaining({ text: "New script" })]));
    } finally {
      release();
    }
    const [outcome] = await publish;
    expect(outcome.status).toBe("fulfilled");
    if (outcome.status === "rejected") throw outcome.reason;
    if (!settings) throw new Error("Settings write was not started");
    expect(await settings).toEqual({ ok: true });
    expect(settingsEntered).toBe(true);
    expect(outcome.value.version).toBe(pendingVersion);
    expect(await row()).toMatchObject({ version: pendingVersion, data: { before, skill: expect.stringContaining("New script"), artifacts: outcome.value.artifacts } });
    expect((await versions()).map((version) => version.version)).toEqual([1, original.version]);
  });

  test.each(["builder", "twin"] as const)("refuses invalid_input on saveSpec for a %s; nothing is written", async (kind) => {
    const agent = kind === "twin" ? f.twin : f.roleplay;
    if (kind === "builder") await db.agent.update({ where: { id: agent.id }, data: { data: { source: ROLEPLAY_SOURCE, skill: "Original script" } } });
    const original = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    await expect(saveSpec("agents", agent.slug, 'agent:\n name: "Changed"\n objective: "Changed"\n', f.org.id)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toEqual(original);
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0); expect(files.size).toBe(0); expect(items.size).toBe(0);
  });

  test("unchanged spec upload ignores jsonb key order and writes no snapshot", async () => {
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { name: "Legacy", nested: { z: 1, a: 2 } } } });
    expect(await saveSpec("agents", f.roleplay.slug, 'agent:\n nested:\n  a: 2\n  z: 1\n name: "Legacy"\n', f.org.id)).toEqual({ created: false, versionBumped: false, version: 1 });
    expect(await versions()).toEqual([]);
  });

  test("concurrent identical saveSpec uploads must bump once", async () => {
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { name: "Old" } } });
    const lock = database.withLock; let arrivals = 0; let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    spies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      expect(keys).toEqual([`agent:${f.roleplay.slug}`]);
      if (++arrivals === 2) release(); await bothRead;
      return lock(keys, work, options);
    }));
    const save = () => saveSpec("agents", f.roleplay.slug, 'agent:\n name: "New"\n', f.org.id);
    const results = await Promise.allSettled([save(), save()]);
    expect(await row()).toMatchObject({ version: 2, data: { name: "New" } });
    expect((await versions()).map((version) => version.version)).toEqual([1]);
    const outcomes = results.map((result) => {
      if (result.status === "fulfilled") return result.value.version;
      const error: unknown = result.reason;
      return error && typeof error === "object" && "code" in error ? error.code : error;
    });
    expect(outcomes).toEqual([2, 2]);
  });
});
