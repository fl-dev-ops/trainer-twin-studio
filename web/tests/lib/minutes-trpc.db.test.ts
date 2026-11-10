import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { minutesRouter } from "@/lib/minutes-trpc";
import { grantMinutes, recordSessionUsage } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("minutes tRPC (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });
  const caller = (role = "admin") => minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role } });
  const fund = (amount: number) => fundOrg({ orgId: f.org.id, minutes: amount, note: "test" });

  test("all procedures are studio-only, including anonymous and org-less users", async () => {
    for (const ctx of [{ user: null }, { user: null, signedIn: true }, { user: { ...f.learner, orgId: f.org.id, orgSlug: f.org.slug, role: "user" } }]) {
      const api = minutesRouter.createCaller(ctx);
      const code = !ctx.user && !ctx.signedIn ? "UNAUTHORIZED" : "FORBIDDEN";
      await expect(api.org()).rejects.toMatchObject({ code });
      await expect(api.version()).rejects.toMatchObject({ code });
      await expect(api.learner({ email: f.learner.email })).rejects.toMatchObject({ code });
      await expect(api.add({ email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ code });
    }
  });

  test("has no take-back procedure", () => {
    expect(Object.keys(minutesRouter._def.procedures).sort()).toEqual(["add", "addMany", "invite", "learner", "org", "version"]);
    expect(minutesRouter._def.procedures).not.toHaveProperty("takeBack");
  });

  test.each(["admin", "team"])("%s queries exact credit shapes and adds normalized learner credits without changing earlier rows", async (role) => {
    const api = caller(role);
    expect(typeof await api.version()).toBe("string");
    expect(await api.org()).toEqual({ balanceMinutes: 0, addedMinutes: 0, defaultMinutes: 30, maxMinutes: 360, billed: false, grants: [], learners: [] });
    expect(await api.learner({ email: f.learner.email })).toEqual({ givenMinutes: 0, usedMinutes: 0, balanceMinutes: 0, orgBalanceMinutes: 0, maxMinutes: 360, added: [] });

    await fund(100);
    await fundOrg({ orgId: f.org.id, minutes: 20, note: "Second top-up" });
    expect(await api.add({ email: ` ${f.learner.email.toUpperCase()} `, minutes: 30 })).toEqual({ grantedMinutes: 30, balanceMinutes: 30, orgBalanceMinutes: 90 });
    const first = await db.minuteLedger.findFirstOrThrow({ where: { orgId: f.org.id, type: "grant" } });
    expect(first).toMatchObject({ actorUserId: f.trainer.id, note: "Added by trainer", seconds: 1800, email: f.learner.email });
    await db.minuteLedger.update({ where: { id: first.id }, data: { createdAt: new Date("2026-01-03T00:00:00Z") } });
    await recordSessionUsage((await f.session()).id);
    const earlier = await db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
    const earlierBytes = JSON.stringify(earlier);

    expect(await api.add({ email: f.learner.email, minutes: 5, note: "  Extra practice  " })).toEqual({ grantedMinutes: 5, balanceMinutes: 33, orgBalanceMinutes: 85 });
    const after = await db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
    expect(after).toHaveLength(earlier.length + 1);
    const earlierIds = new Set(earlier.map((row) => row.id));
    expect(JSON.stringify(after.filter((row) => earlierIds.has(row.id)))).toBe(earlierBytes);
    const added = after.filter((row) => !earlierIds.has(row.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "grant", seconds: 300, email: f.learner.email, actorUserId: f.trainer.id, note: "Extra practice" });
    const entry = (row: typeof first, by: string | null) => ({ id: row.id, minutes: row.seconds / 60, note: row.note, at: row.createdAt.toISOString(), by });

    expect(await api.org()).toEqual({
      balanceMinutes: 85, addedMinutes: 120, defaultMinutes: 30, maxMinutes: 360,
      billed: true, grants: expect.arrayContaining([expect.objectContaining({ minutes: 100, note: "test", by: null }), expect.objectContaining({ minutes: 20, note: "Second top-up", by: null })]),
      learners: [{ email: f.learner.email, userId: f.learner.id, name: f.learner.name, image: null, givenMinutes: 35, usedMinutes: 1.5, leftMinutes: 33 }],
    });
    expect(await api.learner({ email: ` ${f.learner.email.toUpperCase()} ` })).toEqual({
      givenMinutes: 35, usedMinutes: 1.5, balanceMinutes: 33, orgBalanceMinutes: 85, maxMinutes: 360,
      added: [entry(added[0], f.trainer.name), entry(earlier.find((row) => row.id === first.id)!, f.trainer.name)],
    });
    expect(after.filter((row) => row.type === "grant").reduce((sum, row) => sum + row.seconds, 0)).toBe(35 * 60);
    expect(after.some((row) => row.type === "topup")).toBe(false);
  });

  test("maps short balance to CONFLICT and learner cap to BAD_REQUEST", async () => {
    await expect(caller().add({ email: f.learner.email, minutes: 30 })).rejects.toMatchObject({ code: "CONFLICT" });
    await fund(400);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 360 });
    await expect(caller().add({ email: f.learner.email, minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test.each([0, -1, 1.5, 361])("validates amount %s before writing", async (minutes) => {
    await expect(caller().add({ email: f.learner.email, minutes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

  test("studio email refusal is case-insensitive even when user.email contains capitals", async () => {
    await fund(100);
    await db.user.update({ where: { id: f.trainer.id }, data: { email: f.trainer.email.toUpperCase() } });
    await expect(caller().add({ email: f.trainer.email, minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("studio team") });
  });
});
