import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hydrateAgentSkill, getMappedSkillPackage, readAgentSkillVersion, carryAgentSkillVersion } from "@/lib/skill-history";
import { builtFrom, usedIn } from "@/lib/skill-sources";
import { skillPackageHash } from "@/lib/skills";
import { db, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase)("Phase 4 exact Agent package history (real Postgres)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let skillId: string;
  let v1: string;
  let v2: string;

  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create(); await other.create();
    const skill = await db.skill.create({ data: { orgId: f.org.id, ownerSlug: f.roleplay.slug, name: "History" } });
    skillId = skill.id;
    const versions = [];
    for (const version of [1, 2]) {
      const text = `# Skill ${version}\n`;
      const manifest = { scenario: `scenario-${version}` };
      const files = { "SKILL.md": text, "scenario.json": JSON.stringify(manifest), "items.json": "[]" };
      versions.push(await db.skillVersion.create({ data: {
        skillId, version, format: "authored-roleplay", status: "ready", indexStatus: "ready",
        skillText: text, manifest, files, contentHash: skillPackageHash("authored-roleplay", files),
        artifacts: `orgs/${f.org.id}/skills/${skillId}/v${version}`, itemCount: 0,
      } }));
    }
    [v1, v2] = versions.map((version) => version.id);
    await db.skill.update({ where: { id: skillId }, data: { currentVersionId: v2 } });
    await db.agent.update({ where: { id: f.roleplay.id }, data: {
      primarySkillId: skillId, version: 3,
      data: { objective: "Keep objective", after: { goals: ["Keep goals"] }, skill: "Stale", scenario: { scenario: "stale" }, artifacts: versions[0].artifacts },
    } });
    await db.agentSkillVersion.createMany({ data: [1, 2, 3].map((agentVersion) => ({
      orgId: f.org.id, agentId: f.roleplay.id, agentVersion, skillVersionId: agentVersion < 3 ? v1 : v2,
    })) });
  });

  afterEach(async () => {
    await db.agentSkillVersion.deleteMany({ where: { orgId: { in: [f.org.id, other.org.id] } } });
    await db.skillVersionSource.deleteMany({ where: { orgId: { in: [f.org.id, other.org.id] } } });
    await db.skillSource.deleteMany({ where: { orgId: f.org.id } });
    await db.agent.updateMany({ where: { orgId: f.org.id }, data: { primarySkillId: null } });
    await db.skill.updateMany({ where: { orgId: f.org.id }, data: { currentVersionId: null } });
    await db.skillVersion.deleteMany({ where: { skill: { orgId: { in: [f.org.id, other.org.id] } } } });
    await db.skill.deleteMany({ where: { orgId: { in: [f.org.id, other.org.id] } } });
    await other.clean(); await f.clean();
  });

  test("historical versions and settings-only changes resolve exact mappings, never current pointers", async () => {
    expect((await readAgentSkillVersion(f.org.id, f.roleplay.id, 1))?.id).toBe(v1);
    expect(await readAgentSkillVersion(f.org.id, f.roleplay.id, 1)).not.toHaveProperty("files");
    expect((await readAgentSkillVersion(f.org.id, f.roleplay.id, 2))?.id).toBe(v1);
    expect((await readAgentSkillVersion(f.org.id, f.roleplay.id, 3))?.id).toBe(v2);
    expect(await readAgentSkillVersion(f.org.id, f.roleplay.id, 4)).toBeNull();
    expect(await readAgentSkillVersion(other.org.id, f.roleplay.id, 1)).toBeNull();
    expect((await getMappedSkillPackage(f.org.id, f.roleplay.id, 1, db, { verifyFiles: true }))?.files?.["SKILL.md"]).toBe("# Skill 1\n");
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const hydrated = await hydrateAgentSkill(f.org.id, { ...agent, version: 2 });
    expect(hydrated.data).toMatchObject({ objective: "Keep objective", after: { goals: ["Keep goals"] }, skill: "# Skill 1\n", scenario: { scenario: "scenario-1" } });
    expect(hydrated).toMatchObject({ id: agent.id, version: 2, primarySkillId: skillId });
    expect(agent.data).toMatchObject({ skill: "Stale" });
    await db.$transaction(async (tx) => {
      await carryAgentSkillVersion(f.org.id, f.roleplay.id, 2, 4, tx);
      await carryAgentSkillVersion(f.org.id, f.roleplay.id, 2, 4, tx);
      await carryAgentSkillVersion(f.org.id, f.roleplay.id, 99, 100, tx);
    });
    expect((await readAgentSkillVersion(f.org.id, f.roleplay.id, 4))?.id).toBe(v1);
    expect(await readAgentSkillVersion(f.org.id, f.roleplay.id, 100)).toBeNull();
    await expect(db.$transaction((tx) => carryAgentSkillVersion(f.org.id, f.roleplay.id, 2, 3, tx))).rejects.toMatchObject({ code: "skill_package_unavailable" });
  });

  test("hydration is lightweight; explicit verification catches corrupted immutable files", async () => {
    const original = await db.skillVersion.findUniqueOrThrow({ where: { id: v1 } });
    const malformed = await db.skillVersion.create({ data: { ...original, id: undefined, createdAt: undefined, updatedAt: undefined, version: 3, artifacts: `${original.artifacts}/malformed`, files: { invalid: true } } });
    await db.agentSkillVersion.create({ data: { orgId: f.org.id, agentId: f.roleplay.id, agentVersion: 4, skillVersionId: malformed.id } });
    expect((await getMappedSkillPackage(f.org.id, f.roleplay.id, 4))?.version.id).toBe(malformed.id);
    expect((await getMappedSkillPackage(f.org.id, f.roleplay.id, 4))?.files).toBeUndefined();
    await expect(getMappedSkillPackage(f.org.id, f.roleplay.id, 4, db, { verifyFiles: true })).rejects.toMatchObject({ code: "skill_package_unavailable" });
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    expect((await hydrateAgentSkill(f.org.id, { ...agent, version: 4 })).data).toMatchObject({ skill: "# Skill 1\n" });
    await db.agentSkillVersion.deleteMany({ where: { agentId: f.roleplay.id, agentVersion: 4 } });
    expect((await hydrateAgentSkill(f.org.id, { ...agent, version: 4, data: { artifacts: malformed.artifacts } })).data).toMatchObject({ skill: "# Skill 1\n" });
  });

  test("unmapped Phase 4 packages fall back only to saved artifacts", async () => {
    await db.agentSkillVersion.deleteMany({ where: { agentId: f.roleplay.id } });
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    expect((await hydrateAgentSkill(f.org.id, agent)).data).toMatchObject({ skill: "# Skill 1\n" });
    await expect(hydrateAgentSkill(f.org.id, { ...agent, data: {} })).rejects.toMatchObject({ code: "skill_package_unavailable" });
    const legacy = { ...agent, primarySkillId: null, data: { objective: "Legacy" } };
    expect(await hydrateAgentSkill(f.org.id, legacy)).toBe(legacy);
  });

  test("mapped foreign-owned or failed versions refuse rather than use legacy snapshots", async () => {
    const foreign = await db.skill.create({ data: { orgId: other.org.id, ownerSlug: other.roleplay.slug, name: "Foreign" } });
    const original = await db.skillVersion.findUniqueOrThrow({ where: { id: v1 } });
    const foreignVersion = await db.skillVersion.create({ data: { ...original, id: undefined, createdAt: undefined, updatedAt: undefined, skillId: foreign.id } });
    const failedVersion = await db.skillVersion.create({ data: { ...original, id: undefined, createdAt: undefined, updatedAt: undefined, version: 3, status: "failed" } });
    for (const skillVersionId of [foreignVersion.id, failedVersion.id]) {
      await expect(Promise.resolve(db.agentSkillVersion.create({ data: { orgId: f.org.id, agentId: f.roleplay.id, agentVersion: 4, skillVersionId } }))).rejects.toThrow("ready same-org owner package");
    }
    expect(await readAgentSkillVersion(other.org.id, f.roleplay.id, 1)).toBeNull();
  });

  test("provenance survives failed readiness, settings-only versions, deletion and tenant boundaries", async () => {
    await db.skillVersionSource.create({ data: { skillVersionId: v1, orgId: f.org.id, documentId: "deleted", title: "Saved title", items: 5 } });
    await db.skillSource.create({ data: { agentId: f.roleplay.id, version: 2, orgId: f.org.id, documentId: "legacy", title: "Stale", items: 99 } });
    await db.agent.update({ where: { id: f.roleplay.id }, data: { version: 2 } });
    await db.skillVersion.update({ where: { id: v1 }, data: { indexStatus: "failed" } });
    await db.$transaction((tx) => carryAgentSkillVersion(f.org.id, f.roleplay.id, 2, 4, tx));
    expect((await readAgentSkillVersion(f.org.id, f.roleplay.id, 4))?.id).toBe(v1);
    expect(await builtFrom(f.org.id, [{ agentId: f.roleplay.id, version: 2 }])).toEqual([
      { documentId: "deleted", title: "Saved title", items: 5, exists: false },
    ]);
    expect(await usedIn(f.org.id, "deleted")).toEqual([
      { slug: f.roleplay.slug, name: f.roleplay.name, kind: "roleplay", version: 2, items: 5 },
    ]);
    expect(await builtFrom(other.org.id, [{ agentId: f.roleplay.id, version: 2 }])).toBeNull();
    expect(await usedIn(other.org.id, "deleted")).toEqual([]);
    await db.agent.update({ where: { id: f.roleplay.id }, data: { archivedAt: new Date() } });
    expect(await usedIn(f.org.id, "deleted")).toEqual([]);
  });
});
