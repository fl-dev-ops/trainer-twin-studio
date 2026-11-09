import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as minutes from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("minute ledger rules (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });
  const topup = (amount: number) => minutes.topUpOrg({ orgId: f.org.id, minutes: amount, note: "test" });
  const grant = (amount: number, email = f.learner.email) => minutes.grantMinutes({ orgId: f.org.id, email, minutes: amount });

  test("top-ups, normalized grants and take-backs conserve org and learner credit", async () => {
    expect(await topup(100)).toEqual({ orgBalanceMinutes: 100, duplicate: false });
    expect(await grant(60, ` ${f.learner.email.toUpperCase()} `)).toEqual({ grantedMinutes: 60, balanceMinutes: 60, orgBalanceMinutes: 40 });
    expect(await minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email.toUpperCase(), minutes: 10 }))
      .toEqual({ reclaimedMinutes: 10, balanceMinutes: 50, orgBalanceMinutes: 50 });
    expect(await minutes.learnerBalance(f.org.id, ` ${f.learner.email.toUpperCase()} `))
      .toEqual({ email: f.learner.email, grantedSeconds: 3000, usedSeconds: 0, balanceSeconds: 3000 });
    expect((await minutes.learnerMinutes(f.org.id)).size).toBe(1);
    expect(await minutes.learnerMinutes(f.org.id, [])).toEqual(new Map());
    expect(await minutes.orgBalanceSeconds("missing-org")).toBe(0);
  });

  test.each([0, -1, 1.5, NaN, Infinity])("rejects invalid whole-minute amounts: %s without writing", async (amount) => {
    await expect(topup(amount)).rejects.toMatchObject({ name: "MinutesError", status: 400 });
    await expect(grant(amount)).rejects.toMatchObject({ status: 400 });
    await expect(minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: amount })).rejects.toMatchObject({ status: 400 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("short org balance refuses a grant atomically, including exactly one minute short", async () => {
    await topup(29);
    await expect(grant(30)).rejects.toMatchObject({ status: 409 });
    expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(29 * 60);
    expect((await minutes.learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  test("360-minute cap uses grants minus take-backs, not remaining unused credit", async () => {
    await topup(1000);
    await grant(360);
    await minutes.recordSessionUsage((await f.session()).id);
    await expect(grant(1)).rejects.toMatchObject({ status: 400 });
    await minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 1 });
    expect((await grant(1)).balanceMinutes).toBe(358);
    expect((await minutes.learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(360 * 60);
  });

  test("take-backs cannot reclaim spent seconds, but may reclaim exactly the unused balance", async () => {
    await topup(10);
    await grant(10);
    await minutes.recordSessionUsage((await f.session({ endedAt: new Date("2026-01-01T00:02:00Z") })).id);
    await expect(minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 9 })).rejects.toMatchObject({ status: 400 });
    expect(await minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 8 }))
      .toEqual({ reclaimedMinutes: 8, balanceMinutes: 0, orgBalanceMinutes: 8 });
  });

  test("starting minutes normalize/deduplicate emails and remain once-only after a full take-back", async () => {
    await topup(30);
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email, ` ${f.learner.email.toUpperCase()} `] }))
      .toEqual({ given: [f.learner.email] });
    await minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 30 });
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email] })).toEqual({ given: [] });
    expect(await minutes.grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 30, onlyIfNew: true }))
      .toEqual({ grantedMinutes: 0, balanceMinutes: 0, orgBalanceMinutes: 30 });
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails: [] })).toEqual({ given: [] });
  });

  test("starting minutes are all-or-nothing and do not charge known people again", async () => {
    await topup(59);
    const emails = [f.learner.email, `other-${f.learner.email}`];
    await expect(minutes.giveStartingMinutes({ orgId: f.org.id, emails })).rejects.toMatchObject({ status: 409 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
    await topup(1);
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails })).toEqual({ given: emails });
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails })).toEqual({ given: [] });
    expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(0);
  });

  test("parallel grants cannot overspend a small org balance", async () => {
    await topup(30);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => grant(10, `${i}-${f.learner.email}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(5);
    for (const result of rejected) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(3);
  });

  test("parallel grants to one learner cannot exceed the 360-minute cap", async () => {
    await topup(1000);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => grant(60)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(6);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 400 });
    expect((await minutes.learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(360 * 60);
    expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(640 * 60);
  });

  test("parallel take-backs cannot return the same unused minutes twice", async () => {
    await topup(30);
    await grant(30);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 10 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 400 });
    expect((await minutes.learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(0);
    expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(30 * 60);
  });

  test("the same email has independent balances and starting-minute eligibility in different orgs", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      await topup(30);
      await minutes.topUpOrg({ orgId: other.org.id, minutes: 60, note: "other org" });
      for (const orgId of [f.org.id, other.org.id]) {
        expect(await minutes.giveStartingMinutes({ orgId, emails: [f.learner.email] })).toEqual({ given: [f.learner.email] });
      }
      await minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 10 });
      expect((await minutes.learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(1200);
      expect((await minutes.learnerBalance(other.org.id, f.learner.email)).balanceSeconds).toBe(1800);
      expect(await minutes.orgBalanceSeconds(other.org.id)).toBe(1800);
    } finally { await other.clean(); }
  });

  test("parallel starting-minute requests for one email grant it only once", async () => {
    await topup(300);
    const results = await Promise.all(Array.from({ length: 6 }, () => minutes.giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email] })));
    expect(results.flatMap((r) => r.given)).toEqual([f.learner.email]);
    expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(270 * 60);
  });

  test("creditsAdded scopes top-ups and learner grants, newest first, floors seconds and resolves actor name/email/null", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      await db.user.update({ where: { id: f.learner.id }, data: { name: "" } });
      const session = await f.session();
      const additions = [
        { seconds: 121, actorUserId: f.trainer.id, note: "Named actor", createdAt: new Date("2026-01-01T00:00:00Z") },
        { seconds: 59, actorUserId: f.learner.id, note: "Email fallback", createdAt: new Date("2026-01-02T00:00:00Z") },
        { seconds: 239, actorUserId: null, note: null, createdAt: new Date("2026-01-03T00:00:00Z") },
      ];
      // Insert out of order so newest-first cannot pass by insertion order alone.
      for (const index of [1, 2, 0]) {
        for (const type of ["topup", "grant"]) {
          await db.minuteLedger.create({ data: {
            orgId: f.org.id, id: `${f.org.id}-${type}-${index}`, type,
            email: type === "grant" ? f.learner.email : null, ...additions[index],
          } });
        }
      }
      await db.minuteLedger.createMany({ data: [
        { orgId: f.org.id, email: f.learner.email, type: "reclaim", seconds: -60 },
        { orgId: f.org.id, email: f.learner.email, type: "usage", seconds: -90, sessionId: session.id },
        { orgId: f.org.id, email: `other-${f.learner.email}`, type: "grant", seconds: 600 },
        { orgId: other.org.id, type: "topup", seconds: 6000 },
        { orgId: other.org.id, email: f.learner.email, type: "grant", seconds: 1200 },
      ] });
      for (const type of ["topup", "grant"]) {
        const email = type === "grant" ? ` ${f.learner.email.toUpperCase()} ` : undefined;
        const expected = [
          { id: `${f.org.id}-${type}-2`, minutes: 3, note: null, at: "2026-01-03T00:00:00.000Z", by: null },
          { id: `${f.org.id}-${type}-1`, minutes: 0, note: "Email fallback", at: "2026-01-02T00:00:00.000Z", by: f.learner.email },
          { id: `${f.org.id}-${type}-0`, minutes: 2, note: "Named actor", at: "2026-01-01T00:00:00.000Z", by: f.trainer.name },
        ];
        expect(await minutes.creditsAdded(f.org.id, email)).toEqual(expected);
        expect(await minutes.creditsAdded(f.org.id, email, 1)).toEqual(expected.slice(0, 1));
      }
      expect(await minutes.creditsAdded(other.org.id, other.learner.email)).toEqual([]);
      expect(await minutes.creditsAdded("missing-org")).toEqual([]);
      expect(await minutes.creditsAdded("missing-org", f.learner.email)).toEqual([]);
    } finally { await other.clean(); }
  });

  test("orgCreditsAddedSeconds sums only top-ups, not grants, reclaims, usage or another org's top-ups", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      expect(await minutes.orgCreditsAddedSeconds(f.org.id)).toBe(0);
      await topup(30);
      await topup(20);
      await grant(10);
      await minutes.reclaimMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 1 });
      await minutes.recordSessionUsage((await f.session()).id);
      await minutes.topUpOrg({ orgId: other.org.id, minutes: 100, note: "Other org" });
      expect(await minutes.orgCreditsAddedSeconds(f.org.id)).toBe(50 * 60);
      expect(await minutes.orgBalanceSeconds(f.org.id)).toBe(41 * 60);
      expect(await minutes.orgCreditsAddedSeconds("missing-org")).toBe(0);
    } finally { await other.clean(); }
  });

  const badRows = [
    ["unknown type", { type: "refund", seconds: 60, email: "x@example.com" }, "violates check constraint"],
    ["negative topup", { type: "topup", seconds: -60 }, "MinuteLedger_sign_check"],
    ["zero grant", { type: "grant", seconds: 0, email: "x@example.com" }, "MinuteLedger_sign_check"],
    ["negative grant", { type: "grant", seconds: -60, email: "x@example.com" }, "MinuteLedger_sign_check"],
    ["positive reclaim", { type: "reclaim", seconds: 60, email: "x@example.com" }, "MinuteLedger_sign_check"],
    ["zero reclaim", { type: "reclaim", seconds: 0, email: "x@example.com" }, "MinuteLedger_sign_check"],
    ["positive usage", { type: "usage", seconds: 60, email: "x@example.com", sessionId: "s" }, "MinuteLedger_sign_check"],
    ["topup with email", { type: "topup", seconds: 60, email: "x@example.com" }, "MinuteLedger_holder_check"],
    ["grant without email", { type: "grant", seconds: 60 }, "MinuteLedger_holder_check"],
    ["usage without session", { type: "usage", seconds: -60, email: "x@example.com" }, "MinuteLedger_usage_session_check"],
    ["grant with session", { type: "grant", seconds: 60, email: "x@example.com", sessionId: "s" }, "MinuteLedger_usage_session_check"],
    ["uppercase email", { type: "grant", seconds: 60, email: "X@example.com" }, "MinuteLedger_email_lower_check"],
  ] as const;
  for (const [name, row, constraint] of badRows) {
    test(`database CHECK rejects ${name}`, async () => {
      await expect(Promise.resolve(db.minuteLedger.create({ data: { orgId: f.org.id, ...row } }))).rejects.toThrow(constraint);
      expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    });
  }

  test.each([0, -1])("database CHECK rejects nonpositive session allowance %s", async (allowedSeconds) => {
    await expect(Promise.resolve(f.session({ allowedSeconds }))).rejects.toThrow("InterviewSession_allowed_seconds_check");
  });
});
