import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as email from "@/lib/email";
import * as org from "@/lib/org";
import { PUT } from "@/app/api/role-play/[slug]/assignments/route";
import { grantMinutes, learnerBalance } from "@/lib/minutes";
import { twinRouter } from "@/lib/twin/trpc";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("credits stage two assignment entrypoints (local database)", () => {
  let f: MinutesFixture;
  let personEmail: ReturnType<typeof spyOn<typeof email, "sendPersonEmail">>;
  let trainerOrg: ReturnType<typeof spyOn<typeof org, "getTrainerOrg">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    personEmail = spyOn(email, "sendPersonEmail").mockResolvedValue({ success: true });
    trainerOrg = spyOn(org, "getTrainerOrg").mockResolvedValue({ ...f.org, accentColor: null, role: "admin", user: f.trainer });
  });
  afterEach(async () => {
    personEmail?.mockRestore(); trainerOrg?.mockRestore();
    await f.clean();
  });
  const fund = (minutes: number) => fundOrg({ orgId: f.org.id, minutes, note: "stage two test" });
  const caller = () => twinRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const put = (emails: string[], startingMinutes: number) => PUT(new Request("http://localhost/api/role-play/test/assignments", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails, startingMinutes }),
  }), { params: Promise.resolve({ slug: f.roleplay.slug }) });

  test("twin assignments.assign passes startingMinutes to new people and leaves existing grants unchanged", async () => {
    await fund(65);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 20 });
    const existing = await db.minuteLedger.findFirstOrThrow({ where: { orgId: f.org.id, type: "grant" } });
    const fresh = `new-${f.learner.email}`;
    expect(await caller().assignments.assign({ slug: f.twin.slug, emails: [f.learner.email.toUpperCase(), fresh], startingMinutes: 45 })).toMatchObject({ added: 2, emailFailures: 0 });
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(1200);
    expect((await learnerBalance(f.org.id, fresh)).grantedSeconds).toBe(2700);
    expect(await db.minuteLedger.findUnique({ where: { id: existing.id } })).toEqual(existing);
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
    expect(personEmail).toHaveBeenCalledWith(expect.objectContaining({ to: fresh, credits: { added: 45, balance: 45 } }));
    expect(personEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, credits: { balance: 20 } }));
    expect(await caller().assignments.assign({ slug: f.twin.slug, emails: [fresh], startingMinutes: 60 })).toMatchObject({ skipped: 1 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(2);
  });

  test("role-play PUT passes startingMinutes to new people and leaves existing grants unchanged", async () => {
    await fund(65);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 20 });
    const existing = await db.minuteLedger.findFirstOrThrow({ where: { orgId: f.org.id, type: "grant" } });
    const fresh = `new-${f.learner.email}`;
    const response = await put([f.learner.email.toUpperCase(), fresh], 45);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: 2, emailFailures: 0 });
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(1200);
    expect((await learnerBalance(f.org.id, fresh)).grantedSeconds).toBe(2700);
    expect(await db.minuteLedger.findUnique({ where: { id: existing.id } })).toEqual(existing);
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
    expect(personEmail).toHaveBeenCalledTimes(2);
    expect((await put([fresh], 60)).status).toBe(200);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(2);
    expect(personEmail).toHaveBeenCalledTimes(2);
  });

  test.each([0, -1, 1.5, 361])("role-play PUT rejects startingMinutes %d before grants, assignments or email", async (minutes) => {
    const response = await put([f.learner.email], minutes);
    expect(response.status).toBe(400);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(personEmail).not.toHaveBeenCalled();
  });

  test("twin assignments.assign rejects startingMinutes over 360 before writes", async () => {
    await expect(caller().assignments.assign({ slug: f.twin.slug, emails: [f.learner.email], startingMinutes: 361 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(personEmail).not.toHaveBeenCalled();
  });

  test("custom startingMinutes short balance refuses both entrypoints before assignments or mail", async () => {
    await fund(89);
    const emails = [f.learner.email, `other-${f.learner.email}`];
    await expect(caller().assignments.assign({ slug: f.twin.slug, emails, startingMinutes: 45 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await put(emails, 45)).status).toBe(409);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(personEmail).not.toHaveBeenCalled();
  });
});
