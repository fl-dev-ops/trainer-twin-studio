import { withLock } from "@/lib/db";
import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  giveStartingMinutes as startingMinutesInTx, grantMinutes, grantMinutesToMany, learnerBalance,
  recordSessionUsage } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

const giveStartingMinutes = (input: Parameters<typeof startingMinutesInTx>[1]) => withLock([`minutes:${input.orgId}`], (tx) => startingMinutesInTx(tx, input));

describe.skipIf(!localMinutesDb)("credits stage two ledger (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });
  const fund = (minutes: number) => fundOrg({ orgId: f.org.id, minutes, note: "stage two test" });
  const rows = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });

  test("giveStartingMinutes grants the chosen amount once per normalized email, even with no balance left", async () => {
    await fund(45);
    expect(await giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email, ` ${f.learner.email.toUpperCase()} `], minutes: 45, actorUserId: f.trainer.id }))
      .toEqual({ given: [f.learner.email] });
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(45 * 60);
    const before = await rows();
    expect(before.find((row) => row.type === "grant")).toMatchObject({ seconds: 2700, actorUserId: f.trainer.id, note: "Starting minutes" });
    expect(await giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email.toUpperCase()], minutes: 90 })).toEqual({ given: [] });
    expect(await rows()).toEqual(before);
  });

  test.each([0, -1, 0.5, 361])("giveStartingMinutes refuses invalid custom amount %d without writing", async (minutes) => {
    await fund(1000);
    const before = await rows();
    await expect(giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email], minutes })).rejects.toMatchObject({ name: "MinutesError", status: 400 });
    expect(await rows()).toEqual(before);
  });

  test("giveStartingMinutes custom batch is all or nothing, charging only previously uncredited people", async () => {
    await fund(99);
    const other = `other-${f.learner.email}`;
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 10 });
    const emails = [f.learner.email, other, `third-${f.learner.email}`];
    const before = await rows();
    await expect(giveStartingMinutes({ orgId: f.org.id, emails, minutes: 45 })).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toEqual(before);
    await fund(1);
    expect(await giveStartingMinutes({ orgId: f.org.id, emails, minutes: 45 })).toEqual({ given: emails.slice(1) });
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(600);
    expect((await learnerBalance(f.org.id, other)).grantedSeconds).toBe(2700);
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
  });

  test("giveStartingMinutes permits the exact 360-minute boundary", async () => {
    await fund(360);
    expect(await giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email], minutes: 360 })).toEqual({ given: [f.learner.email] });
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(360 * 60);
  });

  test("grantMinutesToMany skips total-given cap even after usage; grants the rest and returns remaining org minutes", async () => {
    await fund(1000);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 350 });
    await recordSessionUsage((await f.session({ allowedSeconds: 350 * 60, endedAt: new Date("2026-01-01T01:00:00Z") })).id);
    const other = `other-${f.learner.email}`;
    await grantMinutes({ orgId: f.org.id, email: other, minutes: 340 });
    const fresh = `fresh-${f.learner.email}`;
    const before = await rows();
    expect(await grantMinutesToMany({ orgId: f.org.id, emails: [f.learner.email, other, fresh], minutes: 20, actorUserId: f.trainer.id, note: "Extra practice" }))
      .toEqual({ given: [other, fresh], skipped: [{ email: f.learner.email, reason: expect.stringContaining("10 more") }], orgBalanceMinutes: 270 });
    const after = await rows();
    expect(after).toHaveLength(before.length + 2);
    expect(after.filter((row) => before.some((earlier) => earlier.id === row.id))).toEqual(before);
    expect(after.filter((row) => !before.some((earlier) => earlier.id === row.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: other, seconds: 1200, actorUserId: f.trainer.id, note: "Extra practice" }),
      expect.objectContaining({ email: fresh, seconds: 1200, actorUserId: f.trainer.id, note: "Extra practice" }),
    ]));
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(350 * 60);
    expect((await learnerBalance(f.org.id, other)).grantedSeconds).toBe(360 * 60);
    expect(await availableOrgSeconds(f.org.id)).toBe(270 * 60);
  });

  test("grantMinutesToMany short balance writes no rows, including for otherwise eligible learners", async () => {
    await fund(369);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 350 });
    const before = await rows();
    await expect(grantMinutesToMany({ orgId: f.org.id, emails: [f.learner.email, `other-${f.learner.email}`, `third-${f.learner.email}`], minutes: 10 }))
      .rejects.toMatchObject({ name: "MinutesError", status: 409 });
    expect(await rows()).toEqual(before);
    expect(await availableOrgSeconds(f.org.id)).toBe(19 * 60);
  });

  test("grantMinutesToMany deduplicates trimmed, case-mixed emails and charges once", async () => {
    await fund(50);
    expect(await grantMinutesToMany({ orgId: f.org.id, emails: [f.learner.email, ` ${f.learner.email.toUpperCase()} `, f.learner.email], minutes: 20 }))
      .toEqual({ given: [f.learner.email], skipped: [], orgBalanceMinutes: 30 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(1200);
  });

  test("grantMinutesToMany all-capped batch returns reasons and unchanged orgBalanceMinutes", async () => {
    await fund(360);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 360 });
    const before = await rows();
    expect(await grantMinutesToMany({ orgId: f.org.id, emails: [f.learner.email], minutes: 1 })).toEqual({
      given: [], skipped: [{ email: f.learner.email, reason: expect.stringContaining("0 more") }], orgBalanceMinutes: 0,
    });
    expect(await rows()).toEqual(before);
  });

  test.each([0, -1, 1.5])("grantMinutesToMany refuses invalid amount %d without writing", async (minutes) => {
    await expect(grantMinutesToMany({ orgId: f.org.id, emails: [f.learner.email], minutes })).rejects.toMatchObject({ status: 400 });
    expect(await rows()).toEqual([]);
  });

  test("grantMinutesToMany and grantMinutes concurrently cannot overspend or partially write the batch", async () => {
    await fund(40);
    const batchEmails = [f.learner.email, `other-${f.learner.email}`];
    const singleEmail = `single-${f.learner.email}`;
    const results = await Promise.allSettled([
      grantMinutesToMany({ orgId: f.org.id, emails: batchEmails, minutes: 20 }),
      grantMinutes({ orgId: f.org.id, email: singleEmail, minutes: 25 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { name: "MinutesError", status: 409 } });
    const grants = (await rows()).filter((row) => row.type === "grant");
    const batchWon = results[0].status === "fulfilled";
    expect(grants.map((row) => row.email).sort()).toEqual((batchWon ? batchEmails : [singleEmail]).sort());
    expect(await availableOrgSeconds(f.org.id)).toBe((batchWon ? 0 : 15) * 60);
    expect(grants.reduce((sum, row) => sum + row.seconds, 0)).toBe((batchWon ? 40 : 25) * 60);
  });
});
