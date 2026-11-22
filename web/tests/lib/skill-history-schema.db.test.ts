import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Prisma } from "@/lib/generated/prisma/client";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("skill history schema (real Postgres)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let skillId: string;
  let versionId: string;

  beforeEach(async () => {
    f = minutesFixture();
    other = minutesFixture();
    await f.create();
    await other.create();
    const skill = await db.skill.create({
      data: { orgId: f.org.id, ownerSlug: f.roleplay.slug, name: "Historical practice" },
    });
    skillId = skill.id;
    const version = await db.skillVersion.create({
      data: packageData(skillId),
    });
    versionId = version.id;
  });

  afterEach(async () => {
    for (const fixture of [other, f]) {
      await db.skillVersionSource.deleteMany({ where: { orgId: fixture.org.id } });
      await db.agent.deleteMany({ where: { orgId: fixture.org.id } });
      await db.skill.updateMany({ where: { orgId: fixture.org.id }, data: { currentVersionId: null } });
      await db.skillVersion.deleteMany({ where: { skill: { orgId: fixture.org.id } } });
      await db.skill.deleteMany({ where: { orgId: fixture.org.id } });
      await fixture.clean();
    }
  });

  function packageData(ownerSkillId: string, overrides: Partial<Prisma.SkillVersionUncheckedCreateInput> = {}): Prisma.SkillVersionUncheckedCreateInput {
    return {
      skillId: ownerSkillId,
      version: 1,
      format: "authored-roleplay",
      status: "ready",
      indexStatus: "ready",
      contentHash: "verified-package-hash",
      skillText: "# Historical practice\n",
      manifest: { scenario: "historical-practice", steps: [] },
      files: {
        "SKILL.md": "# Historical practice\n",
        "scenario.json": '{"scenario":"historical-practice","steps":[]}\n',
        "items.json": "[]\n",
      },
      artifacts: `isolated-history/${ownerSkillId}/v1`,
      itemCount: 0,
      ...overrides,
    };
  }

  const mapping = async (overrides: Partial<Prisma.AgentSkillVersionUncheckedCreateInput> = {}) =>
    db.agentSkillVersion.create({
      data: { agentId: f.roleplay.id, agentVersion: 1, orgId: f.org.id, skillVersionId: versionId, ...overrides },
    });
  const source = async (overrides: Partial<Prisma.SkillVersionSourceUncheckedCreateInput> = {}) =>
    db.skillVersionSource.create({
      data: { skillVersionId: versionId, orgId: f.org.id, documentId: "deleted-document", title: "Saved source title", items: 2, ...overrides },
    });

  test("several experience versions map to one immutable package without requiring primarySkillId", async () => {
    await mapping();
    await mapping({ agentVersion: 7 });
    const agent = await db.agent.findUniqueOrThrow({
      where: { id: f.roleplay.id },
      include: { skillVersions: { orderBy: { agentVersion: "asc" } } },
    });
    expect(agent.primarySkillId).toBeNull();
    expect(agent.skillVersions.map((row) => [row.agentVersion, row.skillVersionId])).toEqual([[1, versionId], [7, versionId]]);
    expect((await db.skillVersion.findUniqueOrThrow({
      where: { id: versionId }, include: { agentVersions: true },
    })).agentVersions).toHaveLength(2);
    await expect(mapping()).rejects.toThrow();
  });

  test.each(["wrong-org", "wrong-agent-org", "wrong-owner"] as const)("rejects %s mappings", async (reason) => {
    await expect(mapping(reason === "wrong-org" ? { orgId: other.org.id }
      : reason === "wrong-agent-org" ? { agentId: other.roleplay.id }
        : { agentId: f.twin.id })).rejects.toThrow();
    expect(await db.agentSkillVersion.count({ where: { skillVersionId: versionId } })).toBe(0);
  });

  test.each([0, -1])("rejects nonpositive experience version %i", async (agentVersion) => {
    await expect(mapping({ agentVersion })).rejects.toThrow();
  });

  test.each([
    ["pending", "pending"],
    ["failed", "failed"],
  ])("requires ready package content at insertion (%s/%s)", async (status, indexStatus) => {
    const unavailable = await db.skillVersion.create({
      data: packageData(skillId, { version: 2, status, indexStatus }),
    });
    await expect(mapping({ skillVersionId: unavailable.id })).rejects.toThrow();
  });

  test.each(["pending", "failed"])("allows history mapping with %s index", async (indexStatus) => {
    await db.skillVersion.update({ where: { id: versionId }, data: { indexStatus } });
    expect(await mapping()).toMatchObject({ skillVersionId: versionId, agentVersion: 1 });
  });

  test("index maintenance after mapping does not change or invalidate history", async () => {
    const saved = await mapping();
    await db.skillVersion.update({
      where: { id: versionId }, data: { indexStatus: "failed", indexGeneration: { increment: 1 }, failure: "Restore required" },
    });
    expect(await db.agentSkillVersion.findUniqueOrThrow({
      where: { agentId_agentVersion: { agentId: f.roleplay.id, agentVersion: 1 } },
    })).toEqual(saved);
    await mapping({ agentVersion: 2 });
    await db.skillVersion.update({ where: { id: versionId }, data: { indexStatus: "ready" } });
    await mapping({ agentVersion: 3 });
  });

  test.each(["agentVersion", "orgId", "skillVersionId", "createdAt"] as const)("mapping %s cannot be updated", async (field) => {
    await mapping();
    const data = field === "agentVersion" ? { agentVersion: 2 }
      : field === "orgId" ? { orgId: other.org.id }
        : field === "skillVersionId" ? { skillVersionId: versionId }
          : { createdAt: new Date(0) };
    await expect(Promise.resolve(db.agentSkillVersion.update({
      where: { agentId_agentVersion: { agentId: f.roleplay.id, agentVersion: 1 } }, data,
    }))).rejects.toThrow();
  });

  test("mapped packages cannot be deleted, but deleting their agent cascades mappings", async () => {
    await mapping();
    await expect(Promise.resolve(db.skillVersion.delete({ where: { id: versionId } }))).rejects.toThrow();
    await db.agent.delete({ where: { id: f.roleplay.id } });
    expect(await db.agentSkillVersion.count({ where: { skillVersionId: versionId } })).toBe(0);
    expect(await db.skillVersion.findUnique({ where: { id: versionId } })).not.toBeNull();
    await db.skillVersion.delete({ where: { id: versionId } });
  });

  test("direct mapping deletion is allowed without deleting package content", async () => {
    await mapping();
    await db.agentSkillVersion.delete({
      where: { agentId_agentVersion: { agentId: f.roleplay.id, agentVersion: 1 } },
    });
    expect(await db.skillVersion.findUnique({ where: { id: versionId } })).not.toBeNull();
  });

  test("mapping does not weaken ready package immutability", async () => {
    await mapping();
    await expect(Promise.resolve(db.skillVersion.update({ where: { id: versionId }, data: { skillText: "# Replaced" } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skillVersion.update({ where: { id: versionId }, data: { status: "pending" } }))).rejects.toThrow();
  });

  test("mapped Agent and Skill tenant/owner identities cannot change", async () => {
    await mapping();
    await expect(Promise.resolve(db.agent.update({ where: { id: f.roleplay.id }, data: { orgId: null } }))).rejects.toThrow();
    await expect(Promise.resolve(db.agent.update({ where: { id: f.roleplay.id }, data: { slug: `${f.roleplay.slug}-renamed` } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skill.update({ where: { id: skillId }, data: { orgId: other.org.id } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skill.update({ where: { id: skillId }, data: { ownerSlug: f.twin.slug } }))).rejects.toThrow();
    await db.agent.update({ where: { id: f.roleplay.id }, data: { name: "Renamed experience", version: 2 } });
    await db.skill.update({ where: { id: skillId }, data: { name: "Renamed skill" } });
  });

  test("provenance retains free document IDs and saved titles after Agent deletion", async () => {
    await source();
    await source({ documentId: "another-deleted-document", title: "", items: 0 });
    await db.agent.delete({ where: { id: f.roleplay.id } });
    const version = await db.skillVersion.findUniqueOrThrow({
      where: { id: versionId }, include: { sources: { orderBy: { documentId: "asc" } } },
    });
    expect(version.sources).toHaveLength(2);
    expect(version.sources[1]).toMatchObject({ documentId: "deleted-document", title: "Saved source title", items: 2 });
    expect(await db.knowledgeDocument.count({ where: { id: "deleted-document" } })).toBe(0);
    await expect(Promise.resolve(db.skillVersion.delete({ where: { id: versionId } }))).rejects.toThrow();
    await expect(source()).rejects.toThrow();
  });

  test("provenance rejects negative counts and cross-org insertion/update", async () => {
    await expect(source({ items: -1 })).rejects.toThrow();
    await expect(source({ orgId: other.org.id })).rejects.toThrow();
    await source();
    const where = { skillVersionId_documentId: { skillVersionId: versionId, documentId: "deleted-document" } };
    await expect(Promise.resolve(db.skillVersionSource.update({ where, data: { orgId: other.org.id } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skillVersionSource.update({ where, data: { items: -1 } }))).rejects.toThrow();
  });

  test("sourced pending packages cannot move across Skill identity or tenant", async () => {
    const pending = await db.skillVersion.create({ data: packageData(skillId, { version: 2, status: "pending" }) });
    await source({ skillVersionId: pending.id });
    const foreign = await db.skill.create({
      data: { orgId: other.org.id, ownerSlug: other.roleplay.slug, name: "Foreign history" },
    });
    await expect(Promise.resolve(db.skillVersion.update({ where: { id: pending.id }, data: { skillId: foreign.id } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skill.update({ where: { id: skillId }, data: { orgId: other.org.id } }))).rejects.toThrow();
    await expect(Promise.resolve(db.skill.update({ where: { id: skillId }, data: { ownerSlug: f.twin.slug } }))).rejects.toThrow();
  });
});
