import { withLock } from "@/lib/db";
import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "./minutes-test-db";
import { randomUUID } from "node:crypto";

// Practice minutes against a real database (the ledger is SQL: sums, locks, CHECKs). Runs only on a local database
// with every migration applied; it makes one throwaway org and removes it.
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "");

const { db } = await import("@/lib/db");
const minutes = await import("@/lib/minutes");
const { activateSession } = await import("@/lib/interview-sessions");
// Other test files replace @/lib/db with fakes for the whole run; this one needs the real client.
const realDb = typeof (db as { $transaction?: unknown }).$transaction === "function" && "minuteLedger" in db;

const run = randomUUID().slice(0, 8);
const orgId = `min-org-${run}`;
const learner = `min-learner-${run}@example.com`;
const other = `min-other-${run}@example.com`;
const userId = `min-user-${run}`;

async function session(fields: { status: string; startedAt: Date | null; endedAt: Date | null; allowedSeconds: number | null }) {
  return db.interviewSession.create({
    data: {
      orgId, userId, agentId: `min-agent-${run}`, shareCode: randomUUID(), personaSlug: "p", personaVersion: 1,
      agentSlug: `min-rp-${run}`, agentVersion: 1, ...fields,
    },
    select: { id: true },
  });
}

const giveStartingMinutes = (input: Parameters<typeof minutes.giveStartingMinutes>[1]) => withLock([`minutes:${input.orgId}`], (tx) => minutes.giveStartingMinutes(tx, input));

describe.skipIf(!local || !realDb)("practice minutes (local database)", () => {
  beforeAll(async () => {
    await db.user.create({ data: { id: `${orgId}-admin`, name: "Admin", email: `${orgId}-admin@example.com`, emailVerified: true } });
    await db.organization.create({ data: { id: orgId, name: "Minutes", slug: orgId, createdAt: new Date(), members: { create: { id: `${orgId}-admin-member`, userId: `${orgId}-admin`, role: "admin", createdAt: new Date() } } } });
    await db.user.create({ data: { id: userId, name: "Learner", email: learner, emailVerified: true } });
    await db.member.create({ data: { id: `min-m-${run}`, organizationId: orgId, userId, role: "user", createdAt: new Date() } });
    const persona = await db.persona.create({ data: { orgId, slug: `min-p-${run}`, name: "P", data: {} }, select: { id: true } });
    await db.agent.create({ data: { id: `min-agent-${run}`, orgId, slug: `min-rp-${run}`, name: "RP", personaId: persona.id, kind: "ROLEPLAY", data: {} } });
  });

  afterAll(async () => {
    await db.interviewSession.deleteMany({ where: { orgId } });
    await db.deployment.deleteMany({ where: { orgId } });
    await db.agent.deleteMany({ where: { orgId } });
    await db.persona.deleteMany({ where: { orgId } });
    await db.organization.delete({ where: { id: orgId } }); // ledger, members cascade
    await db.user.deleteMany({ where: { id: { in: [userId, `${orgId}-admin`] } } });
  });

  test("minutes move from the org's balance to a learner; a short balance and the per-learner cap refuse", async () => {
    await fundOrg({ orgId, minutes: 400, note: "test" });
    const granted = await minutes.grantMinutes({ orgId, email: learner.toUpperCase(), minutes: 60 });
    expect(granted).toEqual({ grantedMinutes: 60, balanceMinutes: 60, orgBalanceMinutes: 340 });
    // The org can't give what it doesn't have.
    await expect(minutes.grantMinutes({ orgId, email: other, minutes: 341 })).rejects.toMatchObject({ status: 409 });
    // One learner holds at most MAX_LEARNER_MINUTES given in total.
    await fundOrg({ orgId, minutes: 1000, note: "test" });
    await expect(minutes.grantMinutes({ orgId, email: learner, minutes: minutes.MAX_LEARNER_MINUTES - 59 })).rejects.toMatchObject({ status: 400 });
    expect((await minutes.grantMinutes({ orgId, email: learner, minutes: minutes.MAX_LEARNER_MINUTES - 60 })).balanceMinutes).toBe(minutes.MAX_LEARNER_MINUTES);
  });

  test("starting minutes: once per person, all or nothing", async () => {
    const result = await giveStartingMinutes({ orgId, emails: [learner, other] });
    expect(result.given).toEqual([other]); // the learner already has minutes
    expect((await minutes.learnerBalance(orgId, other)).balanceSeconds).toBe(minutes.DEFAULT_LEARNER_MINUTES * 60);
    const orgLeft = Math.floor((await availableOrgSeconds(orgId)) / 60);
    const many = Array.from({ length: Math.floor(orgLeft / minutes.DEFAULT_LEARNER_MINUTES) + 1 }, (_, i) => `min-many-${i}-${run}@example.com`);
    await expect(giveStartingMinutes({ orgId, emails: many })).rejects.toMatchObject({ status: 409 });
    expect(await db.minuteLedger.count({ where: { orgId, email: { in: many } } })).toBe(0);
  });

  test("calls: a running one counts up to now, a closed one once and never past its allowance, a failed one not at all", async () => {
    const start = (await minutes.learnerBalance(orgId, learner)).usedSeconds;
    const now = Date.now();
    const live = await session({ status: "active", startedAt: new Date(now - 120_000), endedAt: null, allowedSeconds: 3600 });
    const used = (await minutes.learnerBalance(orgId, learner)).usedSeconds - start;
    expect(used).toBeGreaterThanOrEqual(119);
    expect(used).toBeLessThan(130);

    // Closed after 10 minutes with only 5 allowed: charged 5 minutes, once.
    await db.interviewSession.update({ where: { id: live.id }, data: { status: "completed", startedAt: new Date(now - 600_000), endedAt: new Date(now), allowedSeconds: 300 } });
    await minutes.recordSessionUsage(live.id);
    await minutes.recordSessionUsage(live.id);
    expect(await db.minuteLedger.findMany({ where: { sessionId: live.id }, select: { seconds: true } })).toEqual([{ seconds: -300 }]);
    expect((await minutes.learnerBalance(orgId, learner)).usedSeconds - start).toBe(300);

    const failed = await session({ status: "failed", startedAt: new Date(now - 60_000), endedAt: new Date(now), allowedSeconds: 600 });
    await minutes.recordSessionUsage(failed.id);
    expect((await minutes.learnerBalance(orgId, learner)).usedSeconds - start).toBe(300);
    // Admin and team calls are not metered: no allowance, no usage row.
    const studio = await session({ status: "completed", startedAt: new Date(now - 60_000), endedAt: new Date(now), allowedSeconds: null });
    await minutes.recordSessionUsage(studio.id);
    expect(await db.minuteLedger.count({ where: { sessionId: studio.id } })).toBe(0);
  });

});
