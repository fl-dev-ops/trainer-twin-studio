import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as email from "@/lib/email";
import { minutesRouter } from "@/lib/minutes-trpc";
import { learnerBalance } from "@/lib/minutes";
import { orgPerson } from "@/lib/org-people";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("credits stage two tRPC (local database)", () => {
  let f: MinutesFixture;
  let send: ReturnType<typeof spyOn<typeof email, "sendPersonEmail">>;
  beforeEach(async () => { f = minutesFixture(); await f.create(); send = spyOn(email, "sendPersonEmail").mockResolvedValue({ success: true }); });
  afterEach(async () => { send?.mockRestore(); await f.clean(); });
  const caller = (role = "admin") => minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role } });
  const fund = (minutes: number) => fundOrg({ orgId: f.org.id, minutes, note: "stage two test" });
  const rows = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
  const add = (emails: string[], minutes?: number) => caller().addPeople({ emails, minutes, role: "user" });

  test.each(["admin", "team"])("addMany skips %s studio emails case-insensitively with a reason, giving only learners", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await db.user.update({ where: { id: f.trainer.id }, data: { email: f.trainer.email.toUpperCase() } });
    await fund(50);
    expect(await caller(role).addMany({ emails: [f.trainer.email, f.learner.email.toUpperCase(), f.learner.email], minutes: 20, note: "  Practice  " })).toMatchObject({
      given: [f.learner.email], skipped: [{ email: f.trainer.email, reason: expect.stringContaining("studio team") }], orgBalanceMinutes: 30,
    });
    expect((await rows()).filter((row) => row.type === "grant")).toEqual([
      expect.objectContaining({ email: f.learner.email, seconds: 1200, actorUserId: f.trainer.id, note: "Practice" }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("addMany maps short balance to CONFLICT without writing any grants", async () => {
    await fund(69);
    const other = `other-${f.learner.email}`;
    await add([other]); // Both requested recipients must be members; 39 credits remain.
    const before = await rows(); send.mockClear();
    await expect(caller().addMany({ emails: [f.learner.email, other], minutes: 20 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rows()).toEqual(before); expect(send).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, 361])("addMany validates amount %d before writing", async (minutes) => {
    await expect(caller().addMany({ emails: [f.learner.email], minutes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rows()).toEqual([]); expect(send).not.toHaveBeenCalled();
  });

  test("addPeople gives chosen credits and creates user members immediately, one combined email each", async () => {
    const people = [`added-${f.learner.email}`, `other-${f.learner.email}`];
    await fund(90);
    expect(await add(people.map((e) => e.toUpperCase()), 45)).toMatchObject({ added: 2, already: 0 });
    for (const e of people) {
      expect(await orgPerson(f.org.id, { email: e })).toMatchObject({ role: "user" });
      expect((await learnerBalance(f.org.id, e)).grantedSeconds).toBe(2700);
    }
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect((await rows()).filter((r) => r.type === "grant")).toHaveLength(2);
    expect((await rows()).every((r) => r.actorUserId === f.trainer.id)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await add(people, 60)).toMatchObject({ added: 0, already: 2 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("addPeople defaults to 30 and keeps the chosen grant on repeat", async () => {
    await fund(30);
    expect(await add([`added-${f.learner.email}`])).toMatchObject({ added: 1 });
    const before = await rows();
    expect(await add([`added-${f.learner.email}`], 60)).toMatchObject({ added: 0, already: 1 });
    expect(await rows()).toEqual(before);
    expect((await learnerBalance(f.org.id, `added-${f.learner.email}`)).grantedSeconds).toBe(1800);
  });

  test.each(["admin", "team"])("addPeople refuses %s studio emails before adding anyone", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await db.user.update({ where: { id: f.trainer.id }, data: { email: f.trainer.email.toUpperCase() } });
    await fund(100); const before = await rows();
    await expect(add([`added-${f.learner.email}`, f.trainer.email], 45)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("studio team") });
    expect(await rows()).toEqual(before); expect(send).not.toHaveBeenCalled();
    expect(await orgPerson(f.org.id, { email: `added-${f.learner.email}` })).toBeNull();
  });

  test("addPeople short balance adds nobody and sends nothing", async () => {
    await fund(89); const before = await rows();
    await expect(add([`added-${f.learner.email}`, `other-${f.learner.email}`], 45)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rows()).toEqual(before); expect(send).not.toHaveBeenCalled();
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
  });

  test("addPeople includes an existing member as already instead of failing its email", async () => {
    await fund(90);
    expect(await add([f.learner.email, `added-${f.learner.email}`], 45)).toMatchObject({ added: 1, already: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    for (const e of [f.learner.email, `added-${f.learner.email}`]) expect((await learnerBalance(f.org.id, e)).grantedSeconds).toBe(2700);
  });

  test.each([0, -1, 1.5, 361])("addPeople validates amount %d before writing or sending", async (minutes) => {
    await expect(add([`added-${f.learner.email}`], minutes)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rows()).toEqual([]); expect(send).not.toHaveBeenCalled();
  });
});
