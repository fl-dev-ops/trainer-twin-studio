import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { minutesRouter } from "@/lib/minutes-trpc";
import { grantMinutes, topUpOrg } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("minutes tRPC (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });
  const caller = (role = "admin") => minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role } });
  const fund = (amount: number) => topUpOrg({ orgId: f.org.id, minutes: amount, note: "test" });

  test("all procedures are studio-only, including anonymous and org-less users", async () => {
    for (const ctx of [{ user: null }, { user: null, signedIn: true }, { user: { ...f.learner, orgId: f.org.id, orgSlug: f.org.slug, role: "user" } }]) {
      const api = minutesRouter.createCaller(ctx);
      const code = !ctx.user && !ctx.signedIn ? "UNAUTHORIZED" : "FORBIDDEN";
      await expect(api.org()).rejects.toMatchObject({ code });
      await expect(api.learner({ email: f.learner.email })).rejects.toMatchObject({ code });
      await expect(api.add({ email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ code });
      await expect(api.takeBack({ email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ code });
    }
  });

  test.each(["admin", "team"])("%s can query balances, add and take back normalized learner minutes", async (role) => {
    await fund(100);
    const api = caller(role);
    expect(await api.org()).toMatchObject({ balanceMinutes: 100, defaultMinutes: 30, maxMinutes: 360 });
    expect(await api.add({ email: ` ${f.learner.email.toUpperCase()} `, minutes: 30 })).toEqual({ grantedMinutes: 30, balanceMinutes: 30, orgBalanceMinutes: 70 });
    expect(await api.takeBack({ email: f.learner.email, minutes: 5, note: "  Returned  " })).toEqual({ reclaimedMinutes: 5, balanceMinutes: 25, orgBalanceMinutes: 75 });
    expect(await api.learner({ email: f.learner.email.toUpperCase() })).toMatchObject({ givenMinutes: 25, usedMinutes: 0, balanceMinutes: 25, orgBalanceMinutes: 75, maxMinutes: 360 });
    const rows = await db.minuteLedger.findMany({ where: { orgId: f.org.id, email: f.learner.email } });
    expect(rows.find((r) => r.type === "grant")).toMatchObject({ actorUserId: f.trainer.id, note: "Added by trainer" });
    expect(rows.find((r) => r.type === "reclaim")).toMatchObject({ actorUserId: f.trainer.id, note: "Returned" });
  });

  test("maps short balance to CONFLICT and invalid take-back to BAD_REQUEST", async () => {
    await expect(caller().add({ email: f.learner.email, minutes: 30 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().takeBack({ email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await fund(400);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 360 });
    await expect(caller().add({ email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test.each([0, -1, 1.5, 361])("validates amount %s before writing", async (minutes) => {
    await expect(caller().add({ email: f.learner.email, minutes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().takeBack({ email: f.learner.email, minutes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("rejects invalid emails and overlong notes", async () => {
    await expect(caller().add({ email: "not-email", minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().add({ email: f.learner.email, minutes: 1, note: "x".repeat(201) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test.each(["admin", "team"])("refuses granting minutes to a %s member's email", async (role) => {
    await fund(100);
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await expect(caller().add({ email: f.trainer.email.toUpperCase(), minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("studio team") });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
  });

  // Known regression: assertLearner compares the stored user.email case-sensitively.
  test("studio email refusal is case-insensitive even when user.email contains capitals", async () => {
    await fund(100);
    await db.user.update({ where: { id: f.trainer.id }, data: { email: f.trainer.email.toUpperCase() } });
    await expect(caller().add({ email: f.trainer.email, minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("studio team") });
  });
});
