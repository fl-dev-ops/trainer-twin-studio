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
    if (bytes === undefined) throw new Error(`Missing test file ${key}`);
    return bytes;
  },
}));
const { ingestScenario } = await import("@/lib/scenario-ingest");
const { preserveAgentSkillVersion } = await import("@/lib/skill-version-links");

describe.skipIf(!localMinutesDb)("publisher skill history links (real Postgres)", () => {
  let f: MinutesFixture;
  let documentId: string;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    files.clear();
    spies.push(
      spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _version, _scenario, items) => items.length),
      spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async (_org, _slug, _scenario, _version, items) => items.length),
      spyOn(MainCollectionService, "pruneScenarioItems").mockResolvedValue(undefined),
    );
    const kb = await db.knowledgeBase.create({ data: { orgId: f.org.id, slug: f.org.slug, name: "Source knowledge" } });
    const document = await db.knowledgeDocument.create({
      data: { kbId: kb.id, slug: "recording", title: "Original source title", ext: "txt", size: 1, s3SourceKey: "isolated/source.txt" },
    });
    documentId = document.id;
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
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

  const input = (skill = "# Explore hesitation\n") => ({
    personaSlug: f.org.slug, kind: "ROLEPLAY" as const, skill,
    scenario: {
      scenario: "history-links", name: "History links", description: "Explore a hesitation",
      trainer_role: "Client", learner_role: "Advisor", steps: [{ id: "explore", name: "Explore", trainer_moves: [], learner_moves: [] }],
    },
    items: [{ id: "line-1", role: "trainer" as const, context: "Buyer hesitates", text: "What concerns you?", metadata: { step: "explore", source: documentId } }],
  });
  const agent = (slug: string) => db.agent.findUniqueOrThrow({ where: { slug } });
  const mappings = (agentId: string) => db.agentSkillVersion.findMany({ where: { agentId }, orderBy: { agentVersion: "asc" } });

  test("new publication writes mapping and both provenance representations atomically", async () => {
    const saved = await ingestScenario(f.org.id, input());
    const row = await agent(saved.slug);
    const links = await mappings(row.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ agentVersion: saved.version, orgId: f.org.id });
    expect(await db.skillVersionSource.findMany({ where: { skillVersionId: links[0].skillVersionId } })).toMatchObject([
      { documentId, title: "Original source title", items: 1, orgId: f.org.id },
    ]);
    expect(await db.skillSource.count({ where: { agentId: row.id, version: row.version } })).toBe(1);
    expect(row.data).toMatchObject({ skill: input().skill, artifacts: saved.artifacts });
  });

  test("ready no-op repairs absent links and preserves titles after rename/deletion", async () => {
    const saved = await ingestScenario(f.org.id, input());
    const row = await agent(saved.slug);
    const [original] = await mappings(row.id);
    await db.agentSkillVersion.deleteMany({ where: { agentId: row.id } });
    await db.skillVersionSource.deleteMany({ where: { skillVersionId: original.skillVersionId } });
    await db.knowledgeDocument.update({ where: { id: documentId }, data: { title: "Renamed source" } });
    await ingestScenario(f.org.id, input());
    expect((await mappings(row.id))[0].skillVersionId).toBe(original.skillVersionId);
    expect(await db.skillVersionSource.findMany({ where: { skillVersionId: original.skillVersionId } })).toMatchObject([
      { documentId, title: "Original source title", items: 1 },
    ]);
    await db.knowledgeDocument.delete({ where: { id: documentId } });
    await ingestScenario(f.org.id, input());
    expect(await db.skillVersionSource.count({ where: { skillVersionId: original.skillVersionId } })).toBe(1);
    expect((await agent(saved.slug)).version).toBe(saved.version);
  });

  test("changed publication backfills the exact previous package despite a different current pointer", async () => {
    const first = await ingestScenario(f.org.id, input());
    const oldAgent = await agent(first.slug);
    const [oldLink] = await mappings(oldAgent.id);
    const second = await ingestScenario(f.org.id, input("# Revised hesitation\n"));
    const newAgent = await agent(second.slug);
    const newLinks = await mappings(newAgent.id);
    const newVersion = newLinks[1].skillVersionId;
    await db.agentSkillVersion.deleteMany({ where: { agentId: oldAgent.id } });
    await db.agent.update({
      where: { id: oldAgent.id },
      data: { version: second.version + 1, data: oldAgent.data },
    });
    const third = await ingestScenario(f.org.id, input("# Third revision\n"));
    const links = await mappings(oldAgent.id);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ agentVersion: second.version + 1, skillVersionId: oldLink.skillVersionId });
    expect(links[0].skillVersionId).not.toBe(newVersion);
    expect(links[1].agentVersion).toBe(third.version);
    expect(await db.specVersion.findFirst({
      where: { orgId: f.org.id, entitySlug: first.slug, version: second.version + 1 },
    })).toMatchObject({ data: oldAgent.data });
  });

  test("unchanged archive restoration backfills the same-version mapping", async () => {
    const first = await ingestScenario(f.org.id, input());
    const row = await agent(first.slug);
    const [link] = await mappings(row.id);
    await db.agentSkillVersion.deleteMany({ where: { agentId: row.id } });
    await db.agent.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    const restored = await ingestScenario(f.org.id, input());
    expect(restored.version).toBe(first.version);
    expect((await agent(first.slug)).archivedAt).toBeNull();
    expect((await mappings(row.id))[0].skillVersionId).toBe(link.skillVersionId);
  });

  test("same-package settings publication retains provenance titles and maps both experience versions", async () => {
    const first = await ingestScenario(f.org.id, input());
    const row = await agent(first.slug);
    await db.knowledgeDocument.update({ where: { id: documentId }, data: { title: "Renamed source" } });
    const persona = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-other`, name: "Other client", data: {} } });
    const second = await ingestScenario(f.org.id, { ...input(), personaSlug: persona.slug });
    const links = await mappings(row.id);
    expect(links.map((link) => link.agentVersion)).toEqual([first.version, second.version]);
    expect(links[0].skillVersionId).toBe(links[1].skillVersionId);
    expect(await db.skillVersionSource.findMany({ where: { skillVersionId: links[0].skillVersionId } })).toMatchObject([
      { documentId, title: "Original source title", items: 1 },
    ]);
  });

  test("conflicting stored source counts refuse an otherwise-ready no-op", async () => {
    const first = await ingestScenario(f.org.id, input());
    const row = await agent(first.slug);
    const [link] = await mappings(row.id);
    await db.skillVersionSource.update({
      where: { skillVersionId_documentId: { skillVersionId: link.skillVersionId, documentId } }, data: { items: 9 },
    });
    await expect(ingestScenario(f.org.id, input())).rejects.toMatchObject({ code: "skill_package_unavailable" });
    expect((await agent(first.slug)).version).toBe(first.version);
    expect(await db.skillVersion.count({ where: { skillId: row.primarySkillId! } })).toBe(1);
  });

  test("preserving existing mapping needs neither package fields nor an available index", async () => {
    const first = await ingestScenario(f.org.id, input());
    const row = await agent(first.slug);
    const [link] = await mappings(row.id);
    await db.skillVersion.update({ where: { id: link.skillVersionId }, data: { indexStatus: "failed" } });
    await db.$transaction(tx => preserveAgentSkillVersion(tx, { ...row, primarySkillId: null, data: {} }));
    expect(await mappings(row.id)).toEqual([link]);
    expect(await db.skillVersionSource.findMany({ where: { skillVersionId: link.skillVersionId } })).toMatchObject([
      { documentId, title: "Original source title", items: 1 },
    ]);
  });
});
