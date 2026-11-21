import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ensureSessionSnapshot } from "@/lib/session-snapshot";
import { skillPackageHash } from "@/lib/skills";
import { activateSkillOwnership, skillOwnership } from "@/lib/skill-ownership";
import { checkSkillMigrationCoverage } from "@/lib/skill-migration";
import { MainCollectionService } from "@/lib/main-collection";
import { db, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const isolatedDatabase = "postgresql://surya@localhost:5432/trainertwin_shared_skills_test?host=/tmp";
const files = new Map<string, string>();
const s3 = await import("@/lib/s3");
const readFile = mock(async (key: string) => {
  const value = files.get(key);
  if (value === undefined) {
    const error = new Error(`Missing fixture package: ${key}`);
    error.name = "NoSuchKey";
    throw error;
  }
  return value;
});
mock.module("@/lib/s3", () => ({ ...s3, s3Configured: true, getObjectText: readFile }));

describe.skipIf(process.env.DATABASE_URL !== isolatedDatabase)("historical lazy session snapshots (real Postgres)", () => {
  let f: MinutesFixture;
  let personaId: string;
  let count: ReturnType<typeof spyOn<typeof MainCollectionService, "skillItemCount">>;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    files.clear();
    readFile.mockClear();
    count = spyOn(MainCollectionService, "skillItemCount").mockResolvedValue(0);
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    personaId = agent.personaId;
    const skill = await db.skill.create({ data: { orgId: f.org.id, ownerSlug: agent.slug, name: "Historical package" } });
    for (const version of [1, 2]) {
      const text = `# Instructions ${version}\n`;
      const manifest = { scenario: "historical-package", name: "Historical package", description: "Buyer conversation", trainer_role: "Buyer", learner_role: "Advisor",
        steps: [{ id: "opening", name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }] };
      const packageFiles = { "SKILL.md": text, "scenario.json": JSON.stringify(manifest), "items.json": "[]" };
      const artifacts = `${s3.orgPrefix(f.org.id)}/skills/${skill.id}/v${version}`;
      for (const [name, body] of Object.entries(packageFiles)) files.set(`${artifacts}/${name}`, body);
      const saved = await db.skillVersion.create({ data: {
        skillId: skill.id, version, format: "authored-roleplay", status: "ready", indexStatus: "ready",
        skillText: text, manifest, artifacts, itemCount: 0, files: packageFiles,
        contentHash: skillPackageHash("authored-roleplay", packageFiles),
      } });
      await db.agentSkillVersion.create({ data: { agentId: agent.id, agentVersion: version, skillVersionId: saved.id, orgId: f.org.id } });
      if (version === 2) await db.skill.update({ where: { id: skill.id }, data: { currentVersionId: saved.id } });
    }
    await db.agent.update({ where: { id: agent.id }, data: {
      primarySkillId: skill.id, version: 2,
      data: { name: "New experience", objective: "New objective", source: "scenario-ingest", after: { goals: ["New goal"] } },
    } });
    await db.persona.update({ where: { id: personaId }, data: { version: 2, data: { name: "New persona" } } });
    await db.specVersion.createMany({ data: [
      { orgId: f.org.id, entityType: "agents", entitySlug: agent.slug, version: 1,
        data: { name: "Old experience", objective: "Old objective", source: "scenario-ingest", after: { goals: ["Old goal"] } } },
      { orgId: f.org.id, entityType: "personas", entitySlug: f.org.slug, version: 1, data: { name: "Old persona" } },
    ] });
  });
  afterEach(async () => {
    count.mockRestore();
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

  test("an old null-marker session gets exact package, settings and persona history without files or repinning", async () => {
    const session = await f.session();
    const snapshot = await ensureSessionSnapshot(session.id, f.org.id);
    expect(snapshot).toMatchObject({
      agent: { version: 1, data: { name: "Old experience", skill: "# Instructions 1\n", after: { goals: ["Old goal"] } } },
      persona: { version: 1, data: { name: "Old persona" } },
    });
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, include: { skillPins: true } });
    expect(row.agentVersion).toBe(1);
    expect(row.personaVersion).toBe(1);
    expect(row.skillPinsVersion).toBeNull();
    expect(row.skillPins).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
    expect(await ensureSessionSnapshot(session.id, f.org.id)).toEqual(snapshot);
  });

  test.each(["agents", "personas"])("missing %s experience history refuses despite a usable current package", async (entityType) => {
    const session = await f.session();
    await db.specVersion.deleteMany({ where: { orgId: f.org.id, entityType } });
    await expect(ensureSessionSnapshot(session.id, f.org.id)).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).compiledSnapshot).toBeNull();
  });

  test("a direct assigned session matching current versions can compile lazily", async () => {
    const session = await f.session({ status: "assigned", agentVersion: 2, personaVersion: 2, startedAt: null, endedAt: null });
    expect(await ensureSessionSnapshot(session.id, f.org.id)).toMatchObject({
      agent: { version: 2, data: { skill: "# Instructions 2\n", objective: "New objective" } },
      persona: { version: 2, data: { name: "New persona" } },
    });
  });

  test("a historical no-skill interview does not inherit today's managed package ownership", async () => {
    await db.agentSkillVersion.delete({ where: { agentId_agentVersion: { agentId: f.roleplay.id, agentVersion: 1 } } });
    await db.specVersion.update({
      where: { orgId_entityType_entitySlug_version: { orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 1 } },
      data: { data: { name: "Old interview", objective: "Discuss experience", opening: "Tell me about yourself", config: {}, after: { goals: ["Old interview goal"] } } },
    });
    const session = await f.session();
    const snapshot = await ensureSessionSnapshot(session.id, f.org.id);
    expect(snapshot).toMatchObject({
      agent: { version: 1, primarySkillId: null, data: { opening: "Tell me about yourself", after: { goals: ["Old interview goal"] } } },
      persona: { version: 1, data: { name: "Old persona" } },
    });
    expect(snapshot.agent).not.toHaveProperty("data.skill");
    expect(snapshot.agent).not.toHaveProperty("data.scenario");
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).skillPinsVersion).toBeNull();
  });

  test("managed ownership allows only covered lazy historical references after real local cutover", async () => {
    const session = await f.session();
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    const versions = await db.skillVersion.findMany({ where: { skillId: agent.primarySkillId! }, orderBy: { version: "asc" } });
    const historical = await db.specVersion.findUniqueOrThrow({ where: {
      orgId_entityType_entitySlug_version: { orgId: f.org.id, entityType: "agents", entitySlug: agent.slug, version: 1 },
    } });
    for (const version of versions) {
      const settings = version.version === 1 ? historical.data : agent.data;
      const data = { ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
        skill: version.skillText, scenario: version.manifest, artifacts: version.artifacts };
      if (version.version === 1) await db.specVersion.update({ where: { id: historical.id }, data: { data } });
      else await db.agent.update({ where: { id: agent.id }, data: { data } });
    }
    const report = await checkSkillMigrationCoverage(f.org.id);
    expect(report.complete).toBe(true);
    expect(report.entries.filter((entry) => entry.status !== "verified").map((entry) => entry.error)).toEqual([]);
    expect(report.currentGaps).toEqual([]);
    expect(report.requiredGaps).toEqual([]);
    expect(report.historicalGaps).toEqual([]);
    expect(report.entries.every((entry) => entry.status === "verified")).toBe(true);
    await activateSkillOwnership(f.org.id, { apply: true, inventoryHash: report.hash, canaryReference: "isolated-test-not-live-canary" });
    expect((await skillOwnership(f.org.id)).mode).toBe("managed");
    readFile.mockClear();
    expect(await ensureSessionSnapshot(session.id, f.org.id)).toMatchObject({ agent: { version: 1, data: { skill: "# Instructions 1\n" } } });
    expect(readFile).not.toHaveBeenCalled();
    const uncovered = await f.session();
    await db.agentSkillVersion.delete({ where: { agentId_agentVersion: { agentId: f.roleplay.id, agentVersion: 1 } } });
    await expect(ensureSessionSnapshot(uncovered.id, f.org.id)).rejects.toMatchObject({ code: "skill_package_unavailable", status: 503 });
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: uncovered.id } })).compiledSnapshot).toBeNull();
  });
});
