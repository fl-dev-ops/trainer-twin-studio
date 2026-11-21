import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { db, withLock } from "@/lib/db";
import { MainCollectionService } from "@/lib/main-collection";
import { Prisma } from "@/lib/generated/prisma/client";
import { localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const objects = new Map<string, string>();
const s3 = await import("@/lib/s3");
mock.module("@/lib/s3", () => ({
  ...s3,
  s3Configured: true,
  getObjectText: async (key: string) => {
    const text = objects.get(key);
    if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
    return text;
  },
}));
const { checkSkillMigrationCoverage, migrateSkills } = await import("@/lib/skill-migration");
const { rebuildSkillIndex } = await import("@/lib/skill-index");
const {
  activateSkillOwnership, disableCompatibilityIndex, ownershipLock, packageFieldsOmitted, skillOwnership,
  SkillOwnershipCoverageError,
} = await import("@/lib/skill-ownership");

test("package omission removes only four top-level fields without mutating settings", () => {
  const data = {
    skill: "Instructions", scenario: { name: "Manifest" }, artifacts: "path", filesHash: "hash",
    before: { skill: "Nested setting" }, source: "scenario-ingest", custom: null, enabled: false,
  };
  expect(packageFieldsOmitted(data)).toEqual({
    before: { skill: "Nested setting" }, source: "scenario-ingest", custom: null, enabled: false,
  });
  expect(data.skill).toBe("Instructions");
  expect(packageFieldsOmitted({})).toEqual({});
});

describe.skipIf(!localMinutesDb)("skill ownership (real isolated Postgres)", () => {
  let f: MinutesFixture;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    objects.clear();
    spies.push(spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (_org, _id, _scenario, items) => items.length));
    spies.push(spyOn(MainCollectionService, "skillItemCount").mockResolvedValue(0));
    spies.push(spyOn(MainCollectionService, "writeScenarioItems").mockImplementation(async () => {
      throw new Error("Ownership activation must not write compatibility indexes.");
    }));
    spies.push(spyOn(MainCollectionService, "pruneScenarioItems").mockImplementation(async () => {
      throw new Error("Ownership activation must not prune compatibility indexes.");
    }));
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

  async function legacy(version = 1) {
    const manifest = {
      scenario: "ownership", name: "Ownership fixture", description: "Isolated ownership test",
      trainer_role: "Buyer", learner_role: "Advisor",
      steps: [{ id: "opening", name: "Opening", trainer_moves: ["answer"], learner_moves: ["ask"] }],
    };
    const artifacts = `${s3.orgPrefix(f.org.id)}/ownership/v${version}`;
    const files = { "SKILL.md": `# Isolated version ${version}\n`, "scenario.json": JSON.stringify(manifest), "items.json": "[]" };
    for (const [name, text] of Object.entries(files)) objects.set(`${artifacts}/${name}`, text);
    const data = { skill: files["SKILL.md"], scenario: manifest, artifacts, source: "scenario-ingest", before: { welcome: "Settings" } };
    await db.agent.update({ where: { id: f.roleplay.id }, data: { version, data } });
    return data;
  }
  async function approval() {
    return {
      apply: true, inventoryHash: (await checkSkillMigrationCoverage(f.org.id)).hash,
      canaryReference: "isolated-fixture-attestation:not-a-live-provider-canary",
    };
  }
  async function ready() {
    await legacy();
    const report = await migrateSkills(f.org.id, { apply: true });
    expect(report.currentGaps).toEqual([]);
    return approval();
  }

  test("missing ownership defaults to compatibility without creating state", async () => {
    expect(await skillOwnership(f.org.id)).toMatchObject({ mode: "compatibility", approvedAt: null });
    const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "SkillOwnership" WHERE "orgId" = ${f.org.id}`;
    expect(rows[0].count).toBe(0n);
    expect(ownershipLock(f.org.id)).toBe(`skill-ownership:${f.org.id}`);
    await withLock([ownershipLock(f.org.id)], async (tx) => {
      expect((await skillOwnership(f.org.id, tx)).mode).toBe("compatibility");
    });
  });

  test("SQL defaults, allowed modes, foreign key and organization cascade", async () => {
    await db.$executeRaw`INSERT INTO "SkillOwnership" ("orgId") VALUES (${f.org.id})`;
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
    await expect(Promise.resolve(db.$executeRaw`UPDATE "SkillOwnership" SET mode = 'unsafe' WHERE "orgId" = ${f.org.id}`)).rejects.toThrow();
    await expect(Promise.resolve(db.$executeRaw`INSERT INTO "SkillOwnership" ("orgId") VALUES (${`${f.org.id}-absent`})`)).rejects.toThrow();
    await f.clean();
    const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "SkillOwnership" WHERE "orgId" = ${f.org.id}`;
    expect(rows[0].count).toBe(0n);
  });

  test("requires explicit approval, inventory hash and nonempty canary reference", async () => {
    const opts = await approval();
    await expect(activateSkillOwnership(f.org.id, { ...opts, apply: false })).rejects.toThrow("explicit apply");
    await expect(activateSkillOwnership(f.org.id, { ...opts, canaryReference: "  " })).rejects.toThrow("attestation");
    await expect(activateSkillOwnership(f.org.id, { ...opts, inventoryHash: "" })).rejects.toThrow("inventory hash");
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
  });

  test("SQL refuses managed mode without approvals and rejects each incomplete approval field", async () => {
    await db.$executeRaw`INSERT INTO "SkillOwnership" ("orgId") VALUES (${f.org.id})`;
    await expect(Promise.resolve(db.$executeRaw`
      UPDATE "SkillOwnership" SET mode = 'managed' WHERE "orgId" = ${f.org.id}`)).rejects.toThrow();
    await db.$executeRaw`DELETE FROM "SkillOwnership" WHERE "orgId" = ${f.org.id}`;
    await expect(Promise.resolve(db.$executeRaw`
      INSERT INTO "SkillOwnership" ("orgId", mode) VALUES (${f.org.id}, 'managed')`)).rejects.toThrow();
    await db.$executeRaw`INSERT INTO "SkillOwnership" ("orgId") VALUES (${f.org.id})`;
    const now = new Date();
    const complete = {
      inventoryHash: "isolated-reviewed-hash", canaryReference: "isolated-fixture:not-live",
      verifiedAt: now, approvedAt: now,
    };
    const incomplete = [
      { ...complete, inventoryHash: null },
      { ...complete, inventoryHash: "" },
      { ...complete, inventoryHash: "   " },
      { ...complete, canaryReference: null },
      { ...complete, canaryReference: "" },
      { ...complete, canaryReference: "   " },
      { ...complete, verifiedAt: null },
      { ...complete, approvedAt: null },
    ];
    for (const approval of incomplete) {
      await expect(Promise.resolve(db.$executeRaw`
        UPDATE "SkillOwnership" SET mode = 'managed',
          "inventoryHash" = ${approval.inventoryHash}, "canaryReference" = ${approval.canaryReference},
          "verifiedAt" = ${approval.verifiedAt}, "approvedAt" = ${approval.approvedAt}
        WHERE "orgId" = ${f.org.id}`)).rejects.toThrow();
      expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
    }
    expect((await activateSkillOwnership(f.org.id, await ready())).mode).toBe("managed");
  });

  test("unmapped current inventory blocks activation and returns actionable details", async () => {
    await legacy();
    try {
      await activateSkillOwnership(f.org.id, await approval());
      throw new Error("Expected coverage refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillOwnershipCoverageError);
      if (!(error instanceof SkillOwnershipCoverageError)) throw error;
      expect(error.report.currentGaps).toEqual([`${f.roleplay.slug}@1`]);
    }
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
  });

  test("required session history blocks activation even with no eligible current package", async () => {
    await f.session({ compiledSnapshot: { twinSkills: [{ slug: f.twin.slug, version: 17 }] } });
    await expect(activateSkillOwnership(f.org.id, await approval())).rejects.toThrow("historical coverage");
  });

  test.each([
    ["SQL NULL", Prisma.DbNull],
    ["JSON null", Prisma.JsonNull],
  ] as const)("%s old session with missing package history blocks ownership activation", async (_label, compiledSnapshot) => {
    await legacy(2);
    await migrateSkills(f.org.id, { apply: true });
    await f.session({ agentVersion: 1, compiledSnapshot });
    const report = await checkSkillMigrationCoverage(f.org.id);
    expect(report.currentGaps).toEqual([]);
    expect(report.requiredGaps).toEqual([`${f.roleplay.slug}@1`]);
    expect(report.entries.find((entry) => entry.agentVersion === 1)).toMatchObject({
      required: true, status: "failed", error: expect.stringContaining("no surviving"),
    });
    await expect(activateSkillOwnership(f.org.id, await approval())).rejects.toThrow("historical coverage");
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
  });

  test.each([
    ["SQL NULL", Prisma.DbNull],
    ["JSON null", Prisma.JsonNull],
  ] as const)("%s known no-skill historical interview does not block managed ownership", async (_label, compiledSnapshot) => {
    const interviewData = { name: "Historical interview", objective: "No skill package was published" };
    await db.specVersion.create({ data: {
      orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 1, data: interviewData,
    } });
    await legacy(2);
    await migrateSkills(f.org.id, { apply: true });
    const session = await f.session({ agentVersion: 1, compiledSnapshot });
    const report = await checkSkillMigrationCoverage(f.org.id);
    expect(report.requiredGaps).toEqual([]);
    expect(report.historicalGaps).toEqual([]);
    expect(report.entries.map((entry) => entry.agentVersion)).toEqual([2]);
    expect((await activateSkillOwnership(f.org.id, await approval())).mode).toBe("managed");
    expect(await db.agentSkillVersion.count({ where: { orgId: f.org.id, agentVersion: 1 } })).toBe(0);
    expect((await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id, version: 1 } })).data).toEqual(interviewData);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).skillPinsVersion).toBeNull();
  });

  test("historical gaps block activation even when current package is fully verified", async () => {
    await ready();
    await db.specVersion.create({ data: {
      orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 9,
      data: { skill: "Missing original history" },
    } });
    expect((await checkSkillMigrationCoverage(f.org.id)).historicalGaps).toEqual([`${f.roleplay.slug}@9`]);
    await expect(activateSkillOwnership(f.org.id, await approval())).rejects.toThrow("historical coverage");
  });

  test("fresh verification rejects broken original bytes even with the same inventory hash", async () => {
    const opts = await ready();
    objects.delete(`${s3.orgPrefix(f.org.id)}/ownership/v1/items.json`);
    await expect(activateSkillOwnership(f.org.id, opts)).rejects.toThrow("verified");
    expect((await skillOwnership(f.org.id)).approvedAt).toBeNull();
  });

  test("newly verified publication invalidates the previously reviewed inventory hash", async () => {
    const opts = await ready();
    await legacy(2);
    await migrateSkills(f.org.id, { apply: true });
    await expect(activateSkillOwnership(f.org.id, opts)).rejects.toThrow("stale");
    expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
  });

  test("activation persists approval, retains projections and snapshots, and is idempotent", async () => {
    const opts = await ready();
    const before = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    await db.specVersion.create({ data: {
      orgId: f.org.id, entityType: "agents", entitySlug: f.roleplay.slug, version: 1, data: before.data,
    } });
    const session = await f.session({ compiledSnapshot: { agent: { data: before.data } } });
    const reviewed = await approval();
    const first = await activateSkillOwnership(f.org.id, reviewed);
    expect(first).toMatchObject({ mode: "managed", inventoryHash: reviewed.inventoryHash, canaryReference: opts.canaryReference });
    expect(first.approvedAt).toBeInstanceOf(Date);
    expect(first.verifiedAt).toBeInstanceOf(Date);
    expect(await activateSkillOwnership(f.org.id, { ...reviewed, canaryReference: "must-not-replace-original-approval" })).toEqual(first);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } })).data).toEqual(before.data);
    expect((await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id } })).data).toEqual(before.data);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).compiledSnapshot).toEqual(session.compiledSnapshot);
    expect(await disableCompatibilityIndex(f.org.id)).toBe(false);
  });

  test("compatibility mode refuses index disable and org state stays isolated", async () => {
    const other = minutesFixture();
    await other.create();
    try {
      await activateSkillOwnership(f.org.id, await ready());
      expect((await skillOwnership(other.org.id)).mode).toBe("compatibility");
      await expect(disableCompatibilityIndex(other.org.id)).rejects.toThrow("before managed");
      await withLock([ownershipLock(f.org.id)], async () => {
        const result = await db.$transaction(async (tx) => tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${ownershipLock(other.org.id)})) AS acquired`);
        expect(result[0].acquired).toBe(true);
      });
    } finally {
      await other.clean();
    }
  });

  test("simultaneous activation converges on one recorded approval", async () => {
    const opts = await ready();
    const states = await Promise.all([activateSkillOwnership(f.org.id, opts), activateSkillOwnership(f.org.id, opts)]);
    expect(states[0]).toEqual(states[1]);
  });

  test("an actual index rebuild claim waits for cutover before provider writes", async () => {
    const opts = await ready();
    const version = await db.skillVersion.findFirstOrThrow({ where: { skill: { orgId: f.org.id } } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = false;
    spies.push(spyOn(s3, "getObjectText").mockImplementation(async (key) => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      const text = objects.get(key);
      if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
      return text;
    }));
    const observedModes: string[] = [];
    spies.push(spyOn(MainCollectionService, "writeSkillItems").mockImplementation(async (orgId, _id, _scenario, items) => {
      observedModes.push((await skillOwnership(orgId)).mode);
      return items.length;
    }));
    const cutover = activateSkillOwnership(f.org.id, opts);
    await entered.promise;
    const rebuild = rebuildSkillIndex(f.org.id, version.id);
    release.resolve();
    await cutover;
    expect(await rebuild).toMatchObject({ versionId: version.id, items: 0 });
    expect(observedModes).toEqual(["managed"]);
    expect((await db.skillVersion.findUniqueOrThrow({ where: { id: version.id } })).indexStatus).toBe("ready");
  });

  test("cutover refuses a real in-flight index rebuild until its ready state is restored", async () => {
    const opts = await ready();
    const version = await db.skillVersion.findFirstOrThrow({ where: { skill: { orgId: f.org.id } } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = false;
    spies.push(spyOn(s3, "getObjectText").mockImplementation(async (key) => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      const text = objects.get(key);
      if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
      return text;
    }));
    const rebuild = rebuildSkillIndex(f.org.id, version.id);
    await entered.promise;
    try {
      expect((await db.skillVersion.findUniqueOrThrow({ where: { id: version.id } })).indexStatus).toBe("pending");
      await expect(activateSkillOwnership(f.org.id, opts)).rejects.toThrow("verified");
      expect((await skillOwnership(f.org.id)).mode).toBe("compatibility");
    } finally {
      release.resolve();
      await rebuild;
    }
    expect((await activateSkillOwnership(f.org.id, opts)).mode).toBe("managed");
  });

  test("fresh coverage holds ownership lock and a cooperating publisher observes managed mode after cutover", async () => {
    const opts = await ready();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = false;
    spies.push(spyOn(s3, "getObjectText").mockImplementation(async (key) => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      const text = objects.get(key);
      if (text === undefined) throw Object.assign(new Error(key), { name: "NoSuchKey" });
      return text;
    }));
    const cutover = activateSkillOwnership(f.org.id, opts);
    await entered.promise;
    let publisher: Promise<void> | undefined;
    try {
      const result = await db.$transaction(async (tx) => tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${ownershipLock(f.org.id)})) AS acquired`);
      expect(result[0].acquired).toBe(false);
      publisher = withLock([ownershipLock(f.org.id), `agent:${f.roleplay.slug}`], async (tx) => {
        expect((await skillOwnership(f.org.id, tx)).mode).toBe("managed");
        const agent = await tx.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
        if (!agent.data || typeof agent.data !== "object" || Array.isArray(agent.data)) throw new Error("Invalid fixture settings");
        await tx.agent.update({ where: { id: agent.id }, data: { data: packageFieldsOmitted(agent.data) } });
      });
    } finally {
      release.resolve();
      await cutover;
      await publisher;
    }
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id } });
    expect(agent.data).toEqual({ source: "scenario-ingest", before: { welcome: "Settings" } });
  });
});
