import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MainCollectionService } from "@/lib/main-collection";
import * as s3 from "@/lib/s3";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const files = new Map<string, string>();
mock.module("@/lib/s3", () => ({
  ...s3, s3Configured: true,
  putObject: async (key: string, bytes: string) => { files.set(key, bytes); },
  getObjectText: async (key: string) => {
    const bytes = files.get(key);
    if (bytes === undefined) throw new Error("Missing stored file");
    return bytes;
  },
}));
const { ingestScenario } = await import("@/lib/scenario-ingest");
const { rebuildSkillIndex } = await import("@/lib/skill-index");

describe.skipIf(!localMinutesDb)("managed skill index recovery", () => {
  let f: MinutesFixture;
  let versionId: string;
  const spies: { mockRestore(): void }[] = [];
  let write: ReturnType<typeof spyOn<typeof MainCollectionService, "writeSkillItems">>;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    files.clear();
    write = spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _id, _scenario, items) => items.length);
    spies.push(write,
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined));
    const saved = await ingestScenario(f.org.id, {
      personaSlug: f.org.slug, kind: "ROLEPLAY", skill: "# Explore the hesitation\n",
      scenario: { scenario: "hesitation", name: "Hesitation", description: "Explore the learner's hesitation.",
        trainer_role: "client", learner_role: "advisor", steps: [{ id: "explore", name: "Explore", trainer_moves: [], learner_moves: [] }] },
      items: [{ id: "line-1", role: "trainer", text: "What concerns you?", context: "The buyer hesitates", metadata: { step: "explore" } }],
    });
    const skill = await db.skill.findUniqueOrThrow({ where: { orgId_ownerSlug: { orgId: f.org.id, ownerSlug: saved.slug } } });
    versionId = skill.currentVersionId!;
    write.mockClear();
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: f.org.id } } });
    await db.skill.deleteMany({ where: { orgId: f.org.id } });
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });
  const version = () => db.skillVersion.findUniqueOrThrow({ where: { id: versionId } });

  test("rebuilds the exact verified S3 package without changing package identity or files", async () => {
    const before = await version();
    const original = new Map(files);
    const result = await rebuildSkillIndex(f.org.id, versionId);
    const after = await version();
    expect(result).toMatchObject({ versionId, items: 1, indexGeneration: 1 });
    expect(after).toMatchObject({ status: "ready", indexStatus: "ready", files: before.files, artifacts: before.artifacts, contentHash: before.contentHash });
    expect(write.mock.calls[0]).toMatchObject([f.org.id, versionId, "hesitation", expect.any(Array), before.artifacts]);
    expect(files).toEqual(original);
    await rebuildSkillIndex(f.org.id, versionId);
    expect(await version()).toMatchObject({ version: before.version, indexGeneration: 2, indexStatus: "ready" });
  });

  test("refuses not_found for another org before accessing providers", async () => {
    await expect(rebuildSkillIndex("other-org", versionId)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(write).not.toHaveBeenCalled();
    expect(await version()).toMatchObject({ indexGeneration: 0, indexStatus: "ready" });
  });

  test("corrupt S3 bytes fail visibly without replacing them from database copies", async () => {
    const before = await version();
    files.set(`${before.artifacts}/items.json`, "[]");
    await expect(rebuildSkillIndex(f.org.id, versionId)).rejects.toMatchObject({ code: "skill_package_unavailable" });
    expect(await version()).toMatchObject({ status: "ready", indexStatus: "failed", contentHash: before.contentHash, files: before.files });
    expect(write).not.toHaveBeenCalled();
    expect(files.get(`${before.artifacts}/items.json`)).toBe("[]");
  });

  test("a failed provider rebuild can be retried without republishing the skill", async () => {
    const before = await version();
    write.mockRejectedValueOnce(new Error("Index unavailable"));
    await expect(rebuildSkillIndex(f.org.id, versionId)).rejects.toThrow("Index unavailable");
    expect(await version()).toMatchObject({ status: "ready", indexStatus: "failed", indexGeneration: 1 });
    await rebuildSkillIndex(f.org.id, versionId);
    expect(await version()).toMatchObject({ version: before.version, indexStatus: "ready", indexGeneration: 2, failure: null });
  });

  test("a stale rebuild failure cannot downgrade a newer successful recovery", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    write.mockImplementationOnce(async () => { entered(); await gate; throw new Error("Old worker failed"); });
    const first = rebuildSkillIndex(f.org.id, versionId).then(() => null, (error: unknown) => error);
    try {
      await started;
      await rebuildSkillIndex(f.org.id, versionId);
      release();
      expect(await first).toMatchObject({ code: "skill_index_superseded", status: 409 });
      expect(await version()).toMatchObject({ status: "ready", indexStatus: "ready", indexGeneration: 2, failure: null });
    } finally {
      release();
      await first;
    }
  });
});
