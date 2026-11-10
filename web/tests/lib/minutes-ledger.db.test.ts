import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as minutes from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("minute ledger rules (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });
  const fund = (amount: number) => fundOrg({ orgId: f.org.id, minutes: amount, note: "test" });
  const grant = (amount: number, email = f.learner.email) => minutes.grantMinutes({ orgId: f.org.id, email, minutes: amount });

  test("short org balance refuses a grant atomically, including exactly one minute short", async () => {
    await fund(29);
    await expect(grant(30)).rejects.toMatchObject({ status: 409 });
    expect(await availableOrgSeconds(f.org.id)).toBe(29 * 60);
    expect((await minutes.learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("starting minutes are all-or-nothing and do not charge known people again", async () => {
    await fund(59);
    const emails = [f.learner.email, `other-${f.learner.email}`];
    await expect(minutes.giveStartingMinutes({ orgId: f.org.id, emails })).rejects.toMatchObject({ status: 409 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
    await fund(1);
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails })).toEqual({ given: emails });
    expect(await minutes.giveStartingMinutes({ orgId: f.org.id, emails })).toEqual({ given: [] });
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
  });

  test("parallel grants cannot overspend a small org balance", async () => {
    await fund(30);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => grant(10, `${i}-${f.learner.email}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(5);
    for (const result of rejected) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(3);
  });

  test("parallel grants to one learner cannot exceed the 360-minute cap", async () => {
    await fund(1000);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => grant(60)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(6);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 400 });
    expect((await minutes.learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(360 * 60);
    expect(await availableOrgSeconds(f.org.id)).toBe(640 * 60);
  });

  test("parallel starting-minute requests for one email grant it only once", async () => {
    await fund(300);
    const results = await Promise.all(Array.from({ length: 6 }, () => minutes.giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email] })));
    expect(results.flatMap((r) => r.given)).toEqual([f.learner.email]);
    expect(await availableOrgSeconds(f.org.id)).toBe(270 * 60);
  });

  test("creditsAdded requires a learner email, normalizes it and returns grants newest first with actor names", async () => {
    await fund(100);
    await minutes.grantMinutes({ orgId: f.org.id, email: ` ${f.learner.email.toUpperCase()} `, minutes: 10, note: "First", actorUserId: f.trainer.id });
    const first = await db.minuteLedger.findFirstOrThrow({ where: { orgId: f.org.id } });
    await db.minuteLedger.update({ where: { id: first.id }, data: { createdAt: new Date("2026-01-01") } });
    await grant(5);
    await minutes.recordSessionUsage((await f.session()).id);
    const history = await minutes.creditsAdded(f.org.id, ` ${f.learner.email.toUpperCase()} `);
    expect(history).toMatchObject([{ minutes: 5, by: null }, { id: first.id, minutes: 10, note: "First", by: f.trainer.name, at: "2026-01-01T00:00:00.000Z" }]);
    expect(await minutes.creditsAdded(f.org.id, f.learner.email, 1)).toEqual(history.slice(0, 1));
    expect(await minutes.creditsAdded("missing", f.learner.email)).toEqual([]);
    expect(await minutes.creditsAdded(f.org.id, "other@example.com")).toEqual([]);
  });

  test.each([0, -1, 1.5, NaN, Infinity])("grant refuses invalid whole-minute amount %s before writing", async (amount) => {
    await expect(grant(amount)).rejects.toMatchObject({ status: 400 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  const badRows = [
    ["unknown type", { type: "unknown", seconds: 60, email: "x@example.com" }, "violates check constraint"],
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
