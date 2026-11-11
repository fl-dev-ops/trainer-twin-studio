import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import * as org from "@/lib/org";
import * as database from "@/lib/db";
import * as generation from "@/lib/spec-generation";
import { DEFAULT_RESUME_INTERVIEW_CONFIG } from "@/lib/interview-config-schema";
import { specDraftBundleSchema } from "@/lib/spec-draft-schema";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Real Postgres and advisory locks; only files, embeddings and the model boundary are replaced.
const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({ ...s3, s3Configured: true, putObject: async (key: string, body: string) => { files.set(key, body); } }));
const { saveRoleplay, ROLEPLAY_SOURCE } = await import("@/lib/scenario-ingest");
const { saveSpec } = await import("@/lib/specs");
const { saveSpecDraft, publishSpecDraft } = await import("@/lib/spec-drafts");
const { roleplayRouter } = await import("@/lib/roleplay/trpc");
const { POST: generate } = await import("@/app/api/agents/[slug]/generate/route");
const rawBuilder: unknown = JSON.parse(readFileSync(new URL("../../data/roleplay/skills/wait-and-see-investor/builder.json", import.meta.url), "utf8"));
const before = { preScreenshare: false, preUpload: true, duringUpload: false, uploadTitle: "Notes", uploadInstruction: "Bring notes" };

function bundle(slug: string, personaSlug: string) {
  return specDraftBundleSchema.parse({
    slug, name: "Legacy role play", personaSlug, grounding: [], assumptions: [], gaps: [],
    agent: {
      id: slug, name: "Legacy role play", version: 1, objective: "Explain the decision", opening: "Hello", principles: ["Be precise"], classifications: {}, knowledge_bases: [],
      config: { interview: DEFAULT_RESUME_INTERVIEW_CONFIG, claim_handling: "resume_evidence", context: { mode: "none", required: false }, scenario: {}, tools: [], actions: { allowed: ["ask_exact_example"], default: "ask_exact_example" }, evidence: { statuses: ["untested"] }, turns: { maximum: 10 }, rendering: { maximum_words: 80, maximum_question_marks: 1, one_focal_ask: true, deterministic_closing: true } },
      stages: [{ id: "example", name: "Example", objective: "Explain", opening: "An example?", config: { knowledge: { tags: [] }, claim_handling: "resume_evidence", context: { mode: "none" }, evidence: { definitions: { example: "One example" }, keys: ["example"], completion_keys: ["example"] }, turns: { minimum: 1, maximum: 3 } } }],
    },
  });
}

describe.skipIf(!localMinutesDb)("Module 4 role-play saves (real Postgres locks)", () => {
  let f: MinutesFixture; let other: MinutesFixture;
  const spies: { mockRestore(): void }[] = [];
  const items = new Map<number, unknown[]>();
  let model: ReturnType<typeof spyOn<typeof generation, "generateSpecBundle">>;
  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture(); await f.create(); await other.create(); files.clear(); items.clear();
    model = spyOn(generation, "generateSpecBundle").mockRejectedValue(new Error("Model must not be called"));
    spies.push(model, spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, version, input) => { items.set(version, input); return input.length; }), spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined), spyOn(org, "studioOrRefusal").mockResolvedValue({ ...f.org, accentColor: null, role: "admin", user: f.trainer }));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    for (const fixture of [other, f]) {
      await db.specDraft.deleteMany({ where: { orgId: fixture.org.id } });
      await db.specVersion.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
  });
  const builder = (opening = "Hello?") => ({ ...(rawBuilder as Record<string, unknown>), persona: f.org.slug, opening });
  const caller = () => roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const row = () => db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
  const versions = () => db.specVersion.findMany({ where: { orgId: f.org.id, entitySlug: f.roleplay.slug }, orderBy: { version: "asc" } });
  const generateRequest = (slug: string) => generate(new Request("https://test/api/agents/generate", { method: "POST", body: JSON.stringify({ instruction: "Practise decisions", name: "Role play", opening: "Hello", personaSlug: f.org.slug, interviewConfig: DEFAULT_RESUME_INTERVIEW_CONFIG }) }), { params: Promise.resolve({ slug }) });

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

  test("saveSettings concurrent with a builder save re-reads under its lock and never restores the old script or bumps version", async () => {
    const original = await saveRoleplay(f.org.id, builder("Old script"), f.roleplay.slug);
    let entered!: () => void; let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const lock = database.withLock;
    let calls = 0; let readOld = false;
    spies.push(spyOn(database, "withLock").mockImplementation((keys, work, options) => {
      expect(keys).toEqual([`agent:${f.roleplay.slug}`]);
      const first = ++calls === 1;
      if (!first) { readOld = true; release(); }
      return lock(keys, async (tx) => {
        if (first) { entered(); await proceed; }
        return work(tx);
      }, options);
    }));
    const save = saveRoleplay(f.org.id, builder("New script"), f.roleplay.slug);
    await writing;
    const [, settings] = await Promise.all([save, caller().builder.saveSettings({ slug: f.roleplay.slug, before })]);
    expect(readOld).toBe(true); expect(settings).toEqual({ ok: true });
    const current = await row(); expect(current.version).toBe(original.version + 1);
    expect(current.data).toMatchObject({ before, source: ROLEPLAY_SOURCE });
    expect((current.data as Record<string, unknown>).skill).toContain("New script");
    expect((current.data as Record<string, unknown>).skill).not.toContain("Old script");
    expect((await versions()).map((version) => version.version)).toEqual([1, original.version]);
  });

  test("refuses not_found when a role play is archived after saveSettings reads it but before its locked write", async () => {
    await saveRoleplay(f.org.id, builder(), f.roleplay.slug);
    const lock = database.withLock;
    spies.push(spyOn(database, "withLock").mockImplementation(async (keys, work, options) => {
      expect(keys).toEqual([`agent:${f.roleplay.slug}`]);
      await db.agent.update({ where: { id: f.roleplay.id }, data: { archivedAt: new Date() } });
      return lock(keys, work, options);
    }));
    const beforeRow = await row();
    await expect(caller().builder.saveSettings({ slug: f.roleplay.slug, before })).rejects.toMatchObject({ code: "NOT_FOUND", cause: { code: "not_found", status: 404 } });
    const after = await row(); expect(after.data).toEqual(beforeRow.data); expect(after.version).toBe(beforeRow.version); expect(after.archivedAt).not.toBeNull();
  });

  test.each(["builder", "twin"] as const)("refuses invalid_input on saveSpec for a %s; nothing is written", async (kind) => {
    const agent = kind === "twin" ? f.twin : f.roleplay;
    if (kind === "builder") await db.agent.update({ where: { id: agent.id }, data: { data: { source: ROLEPLAY_SOURCE, skill: "Original script" } } });
    const original = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    await expect(saveSpec("agents", agent.slug, 'agent:\n name: "Changed"\n objective: "Changed"\n', f.org.id)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toEqual(original);
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0); expect(files.size).toBe(0); expect(items.size).toBe(0);
  });

  test("refuses invalid_input on publishSpecDraft for a builder role play; draft and published row stay untouched", async () => {
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { source: ROLEPLAY_SOURCE, skill: "Original" } } });
    await saveSpecDraft(bundle(f.roleplay.slug, f.org.slug), f.org.id);
    const original = await row(); const draft = await db.specDraft.findUniqueOrThrow({ where: { slug: f.roleplay.slug } });
    await expect(publishSpecDraft(f.roleplay.slug, f.org.id)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    expect(await row()).toEqual(original); expect(await db.specDraft.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
    expect(await versions()).toEqual([]); expect(files.size).toBe(0); expect(items.size).toBe(0);
  });

  test("publishSpecDraft on a twin must refuse invalid_input", async () => {
    await saveSpecDraft(bundle(f.twin.slug, f.org.slug), f.org.id);
    const original = await db.agent.findUniqueOrThrow({ where: { id: f.twin.id } }); const draft = await db.specDraft.findUniqueOrThrow({ where: { slug: f.twin.slug } });
    const error: unknown = await publishSpecDraft(f.twin.slug, f.org.id).catch((error: unknown) => error);
    expect(await db.agent.findUniqueOrThrow({ where: { id: f.twin.id } })).toEqual(original); expect(await db.specDraft.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(draft);
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0); expect(files.size).toBe(0); expect(items.size).toBe(0);
    expect(error).toMatchObject({ code: "invalid_input", status: 400 });
  });

  test("unchanged draft publish ignores jsonb key order and preserves the version and intro video", async () => {
    const input = bundle(f.roleplay.slug, f.org.slug);
    const data = { ...input.agent, knowledge_grounding: [], introVideo: "intro.mp4" };
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(data).reverse()))) } });
    await saveSpecDraft(input, f.org.id);
    expect(await publishSpecDraft(f.roleplay.slug, f.org.id)).toMatchObject({ agentVersion: 1 });
    expect(await publishSpecDraft(f.roleplay.slug, f.org.id)).toMatchObject({ agentVersion: 1 });
    expect(await row()).toMatchObject({ version: 1, data }); expect(await versions()).toEqual([]);
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

  test("refuses name_taken on generation before generateSpecBundle or any draft write", async () => {
    const original = await db.agent.findUniqueOrThrow({ where: { id: other.roleplay.id } });
    const response = await generateRequest(other.roleplay.slug); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "name_taken", error: "That name is used by another organization. Pick another." });
    expect(model).not.toHaveBeenCalled(); expect(await db.specDraft.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.agent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });

  test.each(["builder", "twin"] as const)("refuses invalid_input on generation for a %s before calling the model", async (kind) => {
    const agent = kind === "builder" ? f.roleplay : f.twin;
    if (kind === "builder") await db.agent.update({ where: { id: agent.id }, data: { data: { source: ROLEPLAY_SOURCE } } });
    const original = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    const response = await generateRequest(agent.slug); expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_input" }); expect(model).not.toHaveBeenCalled();
    expect(await db.agent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await db.specDraft.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
