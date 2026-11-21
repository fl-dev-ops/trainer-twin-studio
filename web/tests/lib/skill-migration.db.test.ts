import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import { db, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { skillPackageHash, type SkillFormat } from "@/lib/skills";
import type { Prisma } from "@/lib/generated/prisma/client";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";
const objects = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3,
  s3Configured: true,
  putObject: async (key: string, body: string) => { objects.set(key, body); },
  getObjectText: async (key: string) => {
    const text = objects.get(key);
    if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
    return text;
  },
}));
const { migrateSkills, inventorySkills, checkSkillMigrationCoverage } = await import("@/lib/skill-migration");

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase)("skill migration (real isolated Postgres)", () => {
  let f: MinutesFixture;
  const counts = new Map<string, number>();
  const spies: { mockRestore(): void }[] = [];
  let writer: ReturnType<typeof spyOn<typeof MainCollectionService, "writeSkillItems">>;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    objects.clear(); counts.clear();
    writer = spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, id, _scenario, items, scope) => {
      counts.set(`${id}:${scope}`, items.length);
      return items.length;
    });
    spies.push(writer, spyOn(MainCollectionService, "skillItemCount").mockImplementation(async (_org, id, scope) => counts.get(`${id}:${scope}`) ?? 0));
    spies.push(spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async () => { throw new Error("Migration must never write legacy indexes"); }));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await db.agentSkillVersion.deleteMany({ where: { orgId: f.org.id } });
    await db.skillVersionSource.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  async function legacy(version = 1, options: { format?: SkillFormat; empty?: boolean; text?: string; patterns?: string } = {}) {
    const format = options.format ?? "authored-roleplay";
    const manifest = format === "twin" ? {
      skill: "migration", name: "Migration", description: "Saved package", situations: [{ id: "opening", name: "Opening" }],
    } : {
      scenario: "migration", name: "Migration", description: "Saved package", trainer_role: "Buyer", learner_role: "Advisor",
      steps: [{ id: "opening", name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }],
      ...(format === "builder-roleplay" ? { roleplay: {
        name: "Migration", persona: f.org.slug, situation: { scenario: "Saved concern", learnerRole: "Advisor" },
        difficulty: "medium", opening: "Hello", exampleLines: [], guardedIf: [], opensUpIf: [],
        learnerGoals: ["Ask"], rubric: [{ name: "Ask", points: 100 }],
      } } : {}),
    };
    const items = options.empty ? [] : [{
      id: "example", role: format === "builder-roleplay" ? "client" : "trainer", context: "Opening",
      text: "Saved concern", metadata: { source: "deleted-document", step: "opening" },
    }];
    const files = {
      "SKILL.md": options.text ?? "# Original instructions\n",
      [format === "twin" ? "skill.json" : "scenario.json"]: JSON.stringify(manifest, null, 3),
      "items.json": `${JSON.stringify(items)}\n`,
      ...(options.patterns !== undefined ? { "patterns.md": options.patterns } : {}),
    };
    const artifacts = `${s3.orgPrefix(f.org.id)}/legacy/v${version}`;
    for (const [name, text] of Object.entries(files)) objects.set(`${artifacts}/${name}`, text);
    const data = { skill: files["SKILL.md"], scenario: manifest, artifacts,
      source: format === "builder-roleplay" ? "roleplay-skill" : format === "twin" ? "twin-creator" : "scenario-ingest",
      before: { welcome: "Preserve settings" },
      filesHash: createHash("sha256").update(JSON.stringify(items)).update("\0").update(options.patterns ?? "").digest("hex").slice(0, 16) };
    const agent = format === "twin" || format === "legacy-twin" ? f.twin : f.roleplay;
    await db.agent.update({ where: { id: agent.id }, data: {
      version, data,
    } });
    return { data, files, artifacts, hash: skillPackageHash(format, files) };
  }
  async function history(version: number, data: Prisma.InputJsonValue) {
    await db.specVersion.create({ data: { orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version, data } });
  }

  test.each(["twin", "legacy-twin", "builder-roleplay", "authored-roleplay"] as const)("imports verified original %s bytes without legacy writes", async (format) => {
    const saved = await legacy(1, { format, patterns: "" });
    const before = await db.agent.findUniqueOrThrow({ where: { id: format === "twin" || format === "legacy-twin" ? f.twin.id : f.roleplay.id } });
    const dry = await inventorySkills(f.org.id);
    expect(dry.entries[0]).toMatchObject({ contentHash: saved.hash, status: "unmapped", items: 1 });
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(writer).not.toHaveBeenCalled();
    const applied = await migrateSkills(f.org.id, { apply: true });
    expect(applied.entries[0]).toMatchObject({ status: "imported", contentHash: saved.hash });
    const version = await db.skillVersion.findUniqueOrThrow({ where: { id: applied.entries[0].skillVersionId } });
    expect(version.files).toEqual(saved.files);
    expect(version.artifacts).toBe(saved.artifacts);
    expect(version.status).toBe("ready");
    const after = await db.agent.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.data).toEqual(before.data);
    expect(after.version).toBe(before.version);
    expect(after.personaId).toBe(before.personaId);
    expect((await checkSkillMigrationCoverage(f.org.id)).currentGaps).toEqual([]);
    expect((await inventorySkills(f.org.id)).hash).toBe(dry.hash);
  });

  test("settings-only versions with different original paths share one package, including archived current", async () => {
    const first = await legacy();
    await history(1, first.data);
    await legacy(2);
    await db.agent.update({ where: { id: f.roleplay.id }, data: { archivedAt: new Date() } });
    await migrateSkills(f.org.id, { apply: true });
    await migrateSkills(f.org.id, { apply: true });
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(1);
    const mappings = await db.agentSkillVersion.findMany({ where: { orgId: f.org.id } });
    expect(mappings).toHaveLength(2);
    expect(new Set(mappings.map((row) => row.skillVersionId)).size).toBe(1);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).archivedAt).not.toBeNull();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  test("imports deleted-document saved titles and refuses conflicting provenance", async () => {
    const first = await legacy();
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 1, orgId: f.org.id, documentId: "deleted-document", title: "Deleted original title", items: 1 } });
    await migrateSkills(f.org.id, { apply: true });
    expect(await db.skillVersionSource.findFirst({ where: { orgId: f.org.id } })).toMatchObject({ title: "Deleted original title", items: 1 });
    await history(1, first.data);
    await legacy(2);
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 2, orgId: f.org.id, documentId: "deleted-document", title: "Conflicting title", items: 1 } });
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.entries.find((entry) => entry.agentVersion === 2)).toMatchObject({ status: "failed", error: expect.stringContaining("provenance conflicts") });
  });

  test.each([
    { order: "ascending", versions: 4, sharedPrefix: true },
    { order: "descending", versions: 4, sharedPrefix: true },
    { order: "ascending", versions: 5, sharedPrefix: false },
    { order: "descending", versions: 5, sharedPrefix: false },
  ] as const)("$order settings versions ($versions, shared prefix $sharedPrefix) retain verified provenance", async ({ order, versions, sharedPrefix }) => {
    const saved = await legacy();
    const projections = [];
    for (let version = 1; version <= versions; version++) {
      const next = sharedPrefix ? saved : await legacy(version);
      projections.push({ ...next.data, before: { welcome: `Settings ${version}` } });
    }
    await db.agent.update({ where: { id: f.roleplay.id }, data: { version: versions, data: projections[versions - 1] } });
    const originalSource = await db.skillSource.create({ data: {
      agentId: f.roleplay.id, version: versions, orgId: f.org.id,
      documentId: "deleted-document", title: "Deleted original title", items: 1,
    } });
    if (order === "ascending") {
      for (let version = 1; version < versions; version++) await history(version, projections[version - 1]);
    }
    const first = await migrateSkills(f.org.id, { apply: true });
    expect(first.entries.every((entry) => entry.status === "imported")).toBe(true);
    const session = await f.session({ compiledSnapshot: { agent: { data: saved.data } } });
    if (order === "descending") {
      for (let version = 1; version < versions; version++) await history(version, projections[version - 1]);
    }
    const applied = await migrateSkills(f.org.id, { apply: true });
    expect(applied.entries).toHaveLength(versions);
    expect(applied.entries.map((entry) => entry.status)).toEqual(Array(versions).fill("imported"));
    const versionId = applied.entries[0].skillVersionId;
    expect(new Set(applied.entries.map((entry) => entry.skillVersionId))).toEqual(new Set([versionId]));
    expect(await db.skillVersionSource.findMany({ where: { orgId: f.org.id } })).toEqual([
      expect.objectContaining({ skillVersionId: versionId, documentId: "deleted-document", title: "Deleted original title", items: 1 }),
    ]);
    expect(await db.skillSource.findMany({ where: { orgId: f.org.id } })).toEqual([originalSource]);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).compiledSnapshot).toEqual(session.compiledSnapshot);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).data).toEqual(projections[versions - 1]);
    expect((await checkSkillMigrationCoverage(f.org.id)).entries.map((entry) => entry.status)).toEqual(Array(versions).fill("verified"));
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(1);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  test("an already mapped unknown package is enriched on retry without rebuilding or duplicating provenance", async () => {
    await legacy();
    const first = await migrateSkills(f.org.id, { apply: true });
    const versionId = first.entries[0].skillVersionId;
    expect(await db.skillVersionSource.count({ where: { orgId: f.org.id } })).toBe(0);
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 1, orgId: f.org.id,
      documentId: "deleted-document", title: "Recovered deleted title", items: 1 } });
    for (let retry = 0; retry < 2; retry++) {
      expect((await migrateSkills(f.org.id, { apply: true })).entries[0]).toMatchObject({ status: "imported", skillVersionId: versionId });
    }
    expect(await db.skillVersionSource.findMany({ where: { orgId: f.org.id } })).toEqual([
      expect.objectContaining({ title: "Recovered deleted title", items: 1 }),
    ]);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  test.each([0, 2])("unknown package refuses legacy source count %i and remains retryable", async (items) => {
    const saved = await legacy();
    await migrateSkills(f.org.id, { apply: true });
    await history(1, saved.data);
    await legacy(2);
    const source = await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 2, orgId: f.org.id,
      documentId: "deleted-document", title: "Recovered title", items } });
    expect((await migrateSkills(f.org.id, { apply: true })).entries.find((entry) => entry.agentVersion === 2)).toMatchObject({
      status: "failed", error: expect.stringContaining("count disagrees with items.json"),
    });
    expect(await db.skillVersionSource.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.agentSkillVersion.count({ where: { orgId: f.org.id } })).toBe(1);
    await db.skillSource.update({ where: { agentId_version_documentId: {
      agentId: source.agentId, version: source.version, documentId: source.documentId,
    } }, data: { items: 1 } });
    expect((await migrateSkills(f.org.id, { apply: true })).entries.map((entry) => entry.status)).toEqual(["imported", "imported"]);
  });

  test("known provenance refuses invalid saved counts when an unmapped settings version has no sources", async () => {
    const saved = await legacy();
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 1, orgId: f.org.id,
      documentId: "deleted-document", title: "Saved title", items: 1 } });
    await migrateSkills(f.org.id, { apply: true });
    await history(1, saved.data);
    await legacy(2);
    await db.skillVersionSource.updateMany({ where: { orgId: f.org.id }, data: { items: 2 } });
    expect((await migrateSkills(f.org.id, { apply: true })).entries.find((entry) => entry.agentVersion === 2)).toMatchObject({
      status: "failed", error: expect.stringContaining("provenance disagrees"),
    });
    expect(await db.skillVersionSource.findFirst({ where: { orgId: f.org.id } })).toMatchObject({ title: "Saved title", items: 2 });
  });

  test("byte-identical packages from another owner never supply provenance", async () => {
    const saved = await legacy();
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 1, orgId: f.org.id,
      documentId: "deleted-document", title: "Other owner's title", items: 1 } });
    await migrateSkills(f.org.id, { apply: true });
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const secondOwner = await db.agent.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-second`,
      name: "Second owner", kind: "ROLEPLAY", personaId: agent.personaId, data: saved.data } });
    const report = await migrateSkills(f.org.id, { apply: true });
    const owner = report.entries.find((entry) => entry.slug === f.roleplay.slug);
    const other = report.entries.find((entry) => entry.slug === secondOwner.slug);
    expect(other).toMatchObject({ status: "imported", contentHash: saved.hash });
    expect(other?.skillVersionId).not.toBe(owner?.skillVersionId);
    expect(await db.skillVersionSource.count({ where: { skillVersionId: other?.skillVersionId } })).toBe(0);
    expect(await db.skillVersionSource.findFirst({ where: { skillVersionId: owner?.skillVersionId } })).toMatchObject({ title: "Other owner's title" });
  });

  test("different package bytes never enrich an older unknown package from current sources", async () => {
    const saved = await legacy();
    await history(1, saved.data);
    await legacy(2, { text: "# Different current package\n" });
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 2, orgId: f.org.id,
      documentId: "deleted-document", title: "Current title", items: 1 } });
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.entries.map((entry) => entry.status)).toEqual(["imported", "imported"]);
    expect(await db.skillVersionSource.count({ where: { skillVersionId: report.entries[0].skillVersionId } })).toBe(0);
    expect(await db.skillVersionSource.findFirst({ where: { skillVersionId: report.entries[1].skillVersionId } })).toMatchObject({ title: "Current title" });
  });

  test("different original prefix bytes refuse enrichment without changing unknown provenance", async () => {
    const saved = await legacy();
    await migrateSkills(f.org.id, { apply: true });
    await history(1, saved.data);
    await legacy(2);
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 2, orgId: f.org.id,
      documentId: "deleted-document", title: "Verified only if original bytes agree", items: 1 } });
    objects.set(`${saved.artifacts}/SKILL.md`, "# Tampered registered bytes\n");
    expect((await migrateSkills(f.org.id, { apply: true })).entries.find((entry) => entry.agentVersion === 2)).toMatchObject({
      status: "failed", error: expect.stringContaining("differs from verified original bytes"),
    });
    expect(await db.skillVersionSource.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("zero items is ready and reruns do not duplicate rows", async () => {
    await legacy(1, { empty: true });
    await migrateSkills(f.org.id, { apply: true });
    await migrateSkills(f.org.id, { apply: true });
    expect((await checkSkillMigrationCoverage(f.org.id)).entries[0]).toMatchObject({ status: "verified", items: 0 });
    expect(await db.agentSkillVersion.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  test.each(["missing", "corrupt", "projection", "duplicates"] as const)("%s original files are actionable failures, never fabricated", async (failure) => {
    const saved = await legacy();
    if (failure === "missing") objects.delete(`${saved.artifacts}/items.json`);
    if (failure === "corrupt") objects.set(`${saved.artifacts}/items.json`, "{");
    if (failure === "projection") objects.set(`${saved.artifacts}/SKILL.md`, "Changed original");
    if (failure === "duplicates") {
      const items = JSON.parse(saved.files["items.json"]);
      objects.set(`${saved.artifacts}/items.json`, JSON.stringify([...items, ...items]));
    }
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.entries[0].status).toBe("failed");
    expect(report.entries[0].error).toBeTruthy();
    expect(report.currentGaps).toEqual([`${f.roleplay.slug}@1`]);
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(0);
  });

  test("permission errors on optional evidence are not treated as absent files", async () => {
    await legacy();
    const get = spyOn(s3, "getObjectText").mockImplementation(async (key) => {
      if (key.endsWith("/patterns.md")) throw Object.assign(new Error("Restore bucket access"), { name: "AccessDenied" });
      const text = objects.get(key);
      if (text === undefined) throw new Error("Missing fixture");
      return text;
    });
    spies.push(get);
    expect((await inventorySkills(f.org.id)).entries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("AccessDenied") });
  });

  test("failed provider writes leave a durable failed claim and retry the same version", async () => {
    await legacy();
    writer.mockImplementationOnce(async () => { throw new Error("Interrupted index write"); });
    expect((await migrateSkills(f.org.id, { apply: true })).entries[0].status).toBe("failed");
    const failed = await db.skillVersion.findFirstOrThrow({ where: { skill: { orgId: f.org.id } } });
    expect(failed.status).toBe("failed");
    const retry = await migrateSkills(f.org.id, { apply: true });
    expect(retry.entries[0]).toMatchObject({ status: "imported", skillVersionId: failed.id });
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(1);
  });

  test("imported embeddings preflight reads verified items without registry or provider writes", async () => {
    const saved = await legacy();
    const importedEmbeddings = mock((items: { text: string }[]) => {
      expect(items).toEqual(JSON.parse(saved.files["items.json"]));
      return items.map(() => [0.25, 0.75]);
    });
    expect((await migrateSkills(f.org.id, { importedEmbeddings })).entries[0].status).toBe("unmapped");
    expect(importedEmbeddings).toHaveBeenCalledTimes(1);
    expect(writer).not.toHaveBeenCalled();
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
    expect((await migrateSkills(f.org.id, { apply: true, importedEmbeddings })).entries[0].status).toBe("imported");
    expect(writer.mock.calls[0][5]).toEqual({ embeddings: [[0.25, 0.75]] });
    expect((await checkSkillMigrationCoverage(f.org.id)).entries[0].status).toBe("verified");
    await migrateSkills(f.org.id, { apply: true, importedEmbeddings });
    expect(writer).toHaveBeenCalledTimes(1);
    counts.clear();
    expect((await migrateSkills(f.org.id, { apply: true, importedEmbeddings })).entries[0].status).toBe("imported");
    expect(writer.mock.calls[1][5]).toEqual({ embeddings: [[0.25, 0.75]] });
  });

  test.each([false, true])("missing imported embeddings refuse before package claims (apply %s)", async (apply) => {
    await legacy();
    const report = await migrateSkills(f.org.id, { apply, importedEmbeddings: () => { throw new Error("Missing exact imported embedding"); } });
    expect(report.entries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Missing exact imported embedding") });
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(0);
    expect(writer).not.toHaveBeenCalled();
  });

  test("regular migration still calls the native writer without an embedding override", async () => {
    await legacy();
    expect((await migrateSkills(f.org.id, { apply: true })).entries[0].status).toBe("imported");
    expect(writer.mock.calls[0]).toHaveLength(5);
  });

  test("cache coverage preflight fails across packages without partially claiming the covered package", async () => {
    const first = await legacy();
    await history(1, first.data);
    const current = await legacy(2);
    const items = JSON.parse(current.files["items.json"]);
    items[0].text = "An input missing from the imported cache";
    const files = { ...current.files, "items.json": JSON.stringify(items) };
    objects.set(`${current.artifacts}/items.json`, files["items.json"]);
    await db.agent.update({ where: { id: f.roleplay.id }, data: {
      data: { ...current.data, filesHash: skillPackageHash("authored-roleplay", files) },
    } });
    const importedEmbeddings = (entries: { text: string }[]) => entries.map((item) => {
      if (item.text !== "Saved concern") throw new Error("Missing exact imported embedding");
      return [0.25, 0.75];
    });
    const preflight = await migrateSkills(f.org.id, { importedEmbeddings });
    expect(preflight.entries.map((entry) => entry.status)).toEqual(["unmapped", "failed"]);
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(writer).not.toHaveBeenCalled();
  });

  test("package byte validation precedes the imported embedding resolver", async () => {
    const saved = await legacy();
    objects.set(`${saved.artifacts}/SKILL.md`, "# Corrupt package\n");
    const importedEmbeddings = mock(() => [[0.25, 0.75]]);
    expect((await migrateSkills(f.org.id, { apply: true, importedEmbeddings })).entries[0].status).toBe("failed");
    expect(importedEmbeddings).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test.each([false, true])("missing vectors never mask invalid original provenance (apply %s)", async (apply) => {
    await legacy();
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 1, orgId: f.org.id,
      documentId: "deleted-document", title: "Invalid saved count", items: 2 } });
    const importedEmbeddings = mock(() => { throw new Error("Missing exact imported embedding"); });
    expect((await migrateSkills(f.org.id, { apply, importedEmbeddings })).entries[0]).toMatchObject({
      status: "failed", error: expect.stringContaining("count disagrees with items.json"),
    });
    expect(importedEmbeddings).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("imports session-snapshot-only history without rewriting snapshots", async () => {
    const saved = await legacy();
    const session = await f.session({ compiledSnapshot: { agent: { data: saved.data } } });
    await legacy(2, { text: "# New instructions\n" });
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0]).toMatchObject({ agentVersion: 1, required: true, status: "imported" });
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).compiledSnapshot).toEqual(session.compiledSnapshot);
    expect((await checkSkillMigrationCoverage(f.org.id)).requiredGaps).toEqual([]);
  });

  test("unrecoverable catalog pins remain required gaps and do not create artificial packages", async () => {
    await f.session({ compiledSnapshot: { twinSkills: [{ slug: f.twin.slug, version: 17 }] } });
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.requiredGaps).toEqual([`${f.twin.slug}@17`]);
    expect(report.entries[0].error).toContain("no surviving");
    expect(await db.skill.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("bounded cursors cover many versions and preserve hashes on rerun", async () => {
    for (let version = 1; version <= 7; version++) {
      const saved = await legacy(version, { text: `# Revision ${version}\n` });
      if (version < 7) await history(version, saved.data);
    }
    let after: string | undefined;
    const versions: number[] = [];
    do {
      const report = await migrateSkills(f.org.id, { apply: true, batchSize: 2, after });
      expect(report.entries.length).toBeLessThanOrEqual(2);
      versions.push(...report.entries.map((entry) => entry.agentVersion));
      after = report.next ?? undefined;
    } while (after);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const coverage = await checkSkillMigrationCoverage(f.org.id, { batchSize: 2 });
    expect(coverage.complete).toBe(true);
    expect(coverage.currentGaps).toEqual([]);
    expect(coverage.hash).toBe((await checkSkillMigrationCoverage(f.org.id, { batchSize: 3 })).hash);
  });

  test("a live Agent change during package verification is never overwritten", async () => {
    const saved = await legacy();
    let changed = false;
    spies.push(spyOn(s3, "getObjectText").mockImplementation(async (key) => {
      if (!changed) {
        changed = true;
        await db.agent.update({ where: { id: f.roleplay.id }, data: { version: 9, data: { source: "new-publication", skill: "new text", artifacts: "new-live-path" } } });
      }
      const text = objects.get(key);
      if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
      return text;
    }));
    await migrateSkills(f.org.id, { apply: true });
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    expect(agent.version).toBe(9);
    expect(agent.primarySkillId).toBeNull();
    expect(agent.data).not.toEqual(saved.data);
    expect(agent.data).toMatchObject({ source: "new-publication" });
  });

  test("concurrent import claims converge without duplicating package versions", async () => {
    await legacy();
    await Promise.all([migrateSkills(f.org.id, { apply: true }), migrateSkills(f.org.id, { apply: true })]);
    await migrateSkills(f.org.id, { apply: true });
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(1);
    expect(await db.agentSkillVersion.count({ where: { orgId: f.org.id } })).toBe(1);
    expect((await checkSkillMigrationCoverage(f.org.id)).currentGaps).toEqual([]);
  });

  test("failed repair of a pruned ready index is visible and retryable", async () => {
    await legacy();
    await migrateSkills(f.org.id, { apply: true });
    const ready = await db.skillVersion.findFirstOrThrow({ where: { skill: { orgId: f.org.id } } });
    counts.clear();
    writer.mockImplementationOnce(async () => { throw new Error("Index provider unavailable"); });
    const failed = await migrateSkills(f.org.id, { apply: true });
    expect(failed.currentGaps).toEqual([`${f.roleplay.slug}@1`]);
    expect(await db.skillVersion.findUnique({ where: { id: ready.id } })).toMatchObject({ status: "ready", indexStatus: "failed" });
    await migrateSkills(f.org.id, { apply: true });
    expect((await checkSkillMigrationCoverage(f.org.id)).currentGaps).toEqual([]);
  });

  test("migration never takes over a live publisher's new current package", async () => {
    await legacy();
    const { ingestScenario } = await import("@/lib/scenario-ingest");
    spies.push(spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length));
    spies.push(spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined));
    let published = false;
    let publishedVersion = "";
    spies.push(spyOn(s3, "getObjectText").mockImplementation(async (key) => {
      if (!published) {
        published = true;
        await ingestScenario(f.org.id, { kind: "ROLEPLAY", personaSlug: f.org.slug, skill: "# Live publisher\n",
          scenario: { scenario: "rp", name: "Live publisher", description: "A new publication",
            trainer_role: "Buyer", learner_role: "Advisor", steps: [{ id: "opening", name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }] },
          items: [],
        });
        const skill = await db.skill.findFirstOrThrow({ where: { orgId: f.org.id } });
        publishedVersion = skill.currentVersionId!;
      }
      const text = objects.get(key);
      if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
      return text;
    }));
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.entries[0].status).toBe("imported");
    const skill = await db.skill.findFirstOrThrow({ where: { orgId: f.org.id } });
    expect(skill.currentVersionId).toBe(publishedVersion);
    expect(await db.agent.findUnique({ where: { id: f.roleplay.id } })).toMatchObject({ primarySkillId: skill.id, data: { skill: "# Live publisher\n" } });
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(2);
  });

  test("saved evidence hash detects missing optional patterns rather than silently dropping it", async () => {
    const saved = await legacy(1, { patterns: "Original evidence" });
    objects.delete(`${saved.artifacts}/patterns.md`);
    expect((await migrateSkills(f.org.id, { apply: true })).entries[0]).toMatchObject({
      status: "failed", error: expect.stringContaining("filesHash"),
    });
  });

  test("canonical hashes are checked against all original package files", async () => {
    const saved = await legacy();
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { ...saved.data, filesHash: saved.hash } } });
    expect((await inventorySkills(f.org.id)).entries[0].status).toBe("unmapped");
    objects.set(`${saved.artifacts}/items.json`, "[]");
    expect((await inventorySkills(f.org.id)).entries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("filesHash") });
  });

  test("duplicate ready identities at an original artifact prefix refuse explicitly", async () => {
    await legacy();
    await migrateSkills(f.org.id, { apply: true });
    const original = await db.skillVersion.findFirstOrThrow({ where: { skill: { orgId: f.org.id } } });
    await db.skillVersion.create({ data: { skillId: original.skillId, version: 99, format: original.format,
      contentHash: original.contentHash, skillText: original.skillText, files: original.files ?? {}, manifest: original.manifest ?? {},
      artifacts: original.artifacts, itemCount: original.itemCount, status: "ready", indexStatus: "ready" } });
    expect((await inventorySkills(f.org.id)).entries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Ambiguous ready packages") });
  });

  test.each(["cross-org", "traversal"] as const)("%s artifact prefixes refuse before any S3 or index access", async (attack) => {
    const saved = await legacy();
    const artifacts = attack === "cross-org" ? `${s3.orgPrefix("another-org")}/legacy`
      : `${s3.orgPrefix(f.org.id)}/../another-org/legacy`;
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { ...saved.data, artifacts } } });
    const read = spyOn(s3, "getObjectText").mockImplementation(async () => { throw new Error("S3 must not be reached"); });
    spies.push(read);
    expect((await migrateSkills(f.org.id, { apply: true })).entries[0]).toMatchObject({
      status: "failed", error: expect.stringContaining("cross-organization artifact prefix"),
    });
    expect(read).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  test("mapped current and historical versions remain verifiable after package projections are removed", async () => {
    const first = await legacy();
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 1, orgId: f.org.id,
      documentId: "deleted-document", title: "Immutable saved title", items: 1 } });
    await history(1, first.data);
    await legacy(2, { text: "# Current package\n" });
    await migrateSkills(f.org.id, { apply: true });
    const packageCoverageHash = (await checkSkillMigrationCoverage(f.org.id)).hash;
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { before: { welcome: "Current settings only" } } } });
    await db.specVersion.updateMany({ where: { orgId: f.org.id }, data: { data: { before: { welcome: "Historical settings only" } } } });
    await db.skillSource.deleteMany({ where: { orgId: f.org.id } });
    const checked = await checkSkillMigrationCoverage(f.org.id, { batchSize: 1 });
    expect(checked.entries).toHaveLength(2);
    expect(checked.entries.map((entry) => entry.status)).toEqual(["verified", "verified"]);
    expect(checked.currentGaps).toEqual([]);
    expect(checked.historicalGaps).toEqual([]);
    expect(checked.hash).toBe(packageCoverageHash);
    expect((await migrateSkills(f.org.id, { apply: true })).entries.map((entry) => entry.status)).toEqual(["imported", "imported"]);
    expect(await db.skillVersion.count({ where: { skill: { orgId: f.org.id } } })).toBe(2);
    expect(await db.skillVersionSource.findFirst({ where: { orgId: f.org.id } })).toMatchObject({ title: "Immutable saved title" });
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).data).toEqual({ before: { welcome: "Current settings only" } });
    objects.delete(`${first.artifacts}/items.json`);
    expect((await checkSkillMigrationCoverage(f.org.id)).entries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("items.json") });
  });

  test("actual managed activation after deduplicated import retains verified coverage across original and hydrated prefixes", async () => {
    const first = await legacy();
    await history(1, first.data);
    const second = await legacy(2);
    await migrateSkills(f.org.id, { apply: true });
    const mapping = await db.agentSkillVersion.findUniqueOrThrow({
      where: { agentId_agentVersion: { agentId: f.roleplay.id, agentVersion: 2 } }, include: { version: true },
    });
    expect(mapping.version.artifacts).toBe(first.artifacts);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).data).toMatchObject({ artifacts: second.artifacts });
    spies.push(spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (new URL(String(url)).pathname !== "/internal/sessions") throw new Error(`Unexpected network call: ${url}`);
      return new Response(null, { status: 204 });
    }));
    const { activateSession } = await import("@/lib/interview-sessions");
    const session = await activateSession({ orgId: f.org.id, userId: f.trainer.id, agentSlug: f.roleplay.slug, mode: "chat" });
    if (!session) throw new Error("Expected managed activation");
    const saved = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, include: { skillPins: true } });
    expect(saved.skillPinsVersion).toBe(1);
    expect(saved.skillPins[0].skillVersionId).toBe(mapping.skillVersionId);
    expect(saved.compiledSnapshot).toMatchObject({ agent: { data: { artifacts: first.artifacts } } });
    const checked = await checkSkillMigrationCoverage(f.org.id);
    expect(checked.entries.map((entry) => entry.status)).toEqual(["verified", "verified"]);
    expect(checked.requiredGaps).toEqual([]);
    expect(checked.currentGaps).toEqual([]);
    expect((await migrateSkills(f.org.id, { apply: true })).entries.map((entry) => entry.status)).toEqual(["imported", "imported"]);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).compiledSnapshot).toEqual(saved.compiledSnapshot);
    objects.set(`${second.artifacts}/items.json`, "[]");
    expect((await checkSkillMigrationCoverage(f.org.id)).entries.find((entry) => entry.agentVersion === 2)).toMatchObject({
      status: "failed", error: expect.stringContaining("different original package bytes"),
    });
  });
});
