import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { checkOrgPeople, PEOPLE_CHECKS } from "@/scripts/check-org-people";
import { ensureDeployment } from "@/lib/deployments";

// specs/people.md: the database itself refuses the wrong states (migration 20261111120000_people_first).
describe.skipIf(!localMinutesDb)("people rules enforced by the database (local database)", () => {
  let f: MinutesFixture;
  const outsiderId = () => `${f.org.id}-outsider`;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    await db.user.create({ data: { id: outsiderId(), name: "Outsider", email: `outsider-${f.org.id}@example.com`, emailVerified: true } });
  });
  afterEach(async () => {
    await db.invitation.deleteMany({ where: { organizationId: f.org.id } });
    await f.clean();
    await db.user.deleteMany({ where: { id: outsiderId() } });
  });
  // Prisma's lazy promise isn't a real Promise to bun's expect().rejects.
  const run = <T>(query: PromiseLike<T>) => Promise.resolve(query);
  const columns = (table: string) =>
    db.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
      `select column_name, is_nullable from information_schema.columns where table_schema = current_schema() and table_name = $1`, table);
  const twinRow = (userId: string) => ({ orgId: f.org.id, agentId: f.twin.id, userId, minutesLimit: 30, shareCode: `${userId}-code` });

  test("no assignment has a recipientEmail column; TwinAssignment.userId and RolePlayAssignment.memberId are NOT NULL", async () => {
    const twin = await columns("TwinAssignment");
    const roleplay = await columns("RolePlayAssignment");
    expect(twin.map((c) => c.column_name)).not.toContain("recipientEmail");
    expect(roleplay.map((c) => c.column_name)).not.toContain("recipientEmail");
    expect(twin.find((c) => c.column_name === "userId")?.is_nullable).toBe("NO");
    expect(roleplay.find((c) => c.column_name === "memberId")?.is_nullable).toBe("NO");
  });

  test("one member row per account per org", async () => {
    await expect(run(db.member.create({ data: { id: `${f.learner.id}-member-2`, organizationId: f.org.id, userId: f.learner.id, role: "user", createdAt: new Date() } })))
      .rejects.toMatchObject({ code: "P2002" });
  });

  test("a twin assignment must point at a member of its org", async () => {
    await expect(run(db.twinAssignment.create({ data: twinRow(outsiderId()) }))).rejects.toThrow();
    await expect(run(db.$executeRawUnsafe(`insert into "TwinAssignment" (id, "orgId", "agentId", "minutesLimit", "shareCode") values ($1, $2, $3, 30, $1)`, `${f.org.id}-nouser`, f.org.id, f.twin.id)))
      .rejects.toThrow();
    expect(await db.twinAssignment.create({ data: twinRow(f.learner.id) })).toMatchObject({ userId: f.learner.id });
    // One per member per twin.
    await expect(run(db.twinAssignment.create({ data: { ...twinRow(f.learner.id), shareCode: "other" } }))).rejects.toMatchObject({ code: "P2002" });
  });

  test("a role-play assignment can't be stored without a member", async () => {
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    await expect(run(db.$executeRawUnsafe(
      `insert into "RolePlayAssignment" (id, "orgId", "deploymentId", "shareCode", "expiresAt") values ($1, $2, $3, $1, now() + interval '1 day')`,
      `${f.org.id}-nomember`, f.org.id, deployment.id))).rejects.toThrow();
  });

  test("a member's twin assignments go when the member goes (the FK cascades)", async () => {
    await db.twinAssignment.create({ data: twinRow(f.learner.id) });
    await db.member.delete({ where: { id: `${f.learner.id}-member` } });
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("checkOrgPeople reports every check by name and counts a planted break", async () => {
    expect(PEOPLE_CHECKS.map((c) => c.rule)).toEqual([
      "no account has two member rows in one org",
      "every twin assignment's person is a member of its org",
      "every role-play assignment's member is in its org",
      "admin and team hold no twin or role-play assignment",
      "every learner credits row belongs to a member of its org",
      "no pending invitations (people are added straight to their org)",
    ]);
    // These breaks aren't stopped by constraints; deliberately plant them only in this diagnostic test.
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    await db.twinAssignment.create({ data: twinRow(f.trainer.id) });
    await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, assignedByUserId: f.trainer.id, shareCode: `${f.org.id}-studio`, expiresAt: new Date() } });
    await db.minuteLedger.create({ data: { orgId: f.org.id, email: `outsider-${f.org.id}@example.com`, type: "grant", seconds: 60 } });
    await db.invitation.create({ data: { id: `${f.org.id}-inv`, organizationId: f.org.id, email: "x@example.com", role: "user", status: "pending", expiresAt: new Date(Date.now() + 60_000), inviterId: f.trainer.id } });
    const results = new Map((await checkOrgPeople()).map((r) => [r.rule, r.broken]));
    expect(results.get("admin and team hold no twin or role-play assignment")).toBeGreaterThanOrEqual(2);
    expect(results.get("every learner credits row belongs to a member of its org")).toBeGreaterThanOrEqual(1);
    expect(results.get("no pending invitations (people are added straight to their org)")).toBeGreaterThanOrEqual(1);
    expect(results.get("no account has two member rows in one org")).toBe(0);
  });
});
