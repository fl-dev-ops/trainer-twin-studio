import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextHeaders from "next/headers";
import { auth } from "@/lib/auth";
import { minutesRouter } from "@/lib/minutes-trpc";
import { learnerBalance } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Exercise the configured Better Auth hook, not a copy of its grant-once logic.
function beforeCreateInvitation(input: { invitation: { role: string; email: string; inviterId: string }; organization: { id: string } }) {
  const plugin = auth.options.plugins.find((plugin) => plugin.id === "organization");
  const hook = (plugin as unknown as { options: { organizationHooks: {
    beforeCreateInvitation: (input: { invitation: { role: string; email: string; inviterId: string }; organization: { id: string } }) => Promise<void>;
  } } }).options.organizationHooks.beforeCreateInvitation;
  return hook(input);
}

describe.skipIf(!localMinutesDb)("credits stage two tRPC (local database)", () => {
  let f: MinutesFixture;
  let headers: ReturnType<typeof spyOn<typeof nextHeaders, "headers">>;
  const requestHeaders = new Headers({ "x-credits-test": "stage-two" });
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    headers = spyOn(nextHeaders, "headers").mockResolvedValue(requestHeaders);
  });
  afterEach(async () => {
    headers?.mockRestore();
    await db.invitation.deleteMany({ where: { organizationId: f.org.id } });
    await f.clean();
  });
  const caller = (role = "admin") => minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role } });
  const fund = (minutes: number) => fundOrg({ orgId: f.org.id, minutes, note: "stage two test" });
  const rows = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });

  test.each(["admin", "team"])("addMany skips %s studio emails case-insensitively with a reason, giving only learners", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await db.user.update({ where: { id: f.trainer.id }, data: { email: f.trainer.email.toUpperCase() } });
    await fund(50);
    expect(await caller(role).addMany({ emails: [f.trainer.email, f.learner.email.toUpperCase(), f.learner.email], minutes: 20, note: "  Practice  " })).toEqual({
      given: [f.learner.email], skipped: [{ email: f.trainer.email, reason: expect.stringContaining("studio team") }], orgBalanceMinutes: 30,
    });
    expect((await rows()).filter((row) => row.type === "grant")).toEqual([
      expect.objectContaining({ email: f.learner.email, seconds: 1200, actorUserId: f.trainer.id, note: "Practice" }),
    ]);
  });

  test("addMany maps short balance to CONFLICT without writing any grants", async () => {
    await fund(39);
    const before = await rows();
    await expect(caller().addMany({ emails: [f.learner.email, `other-${f.learner.email}`], minutes: 20 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rows()).toEqual(before);
  });

  test.each([0, -1, 1.5, 361])("addMany validates amount %d before writing", async (minutes) => {
    await expect(caller().addMany({ emails: [f.learner.email], minutes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rows()).toEqual([]);
  });

  test("invite grants chosen credits before creating role user invitations; real auth hook does not grant twice", async () => {
    const other = `other-${f.learner.email}`;
    await fund(90);
    expect(await caller().invite({ emails: [`invited-${f.learner.email}`.toUpperCase(), other], minutes: 45 })).toMatchObject({ invited: 2, failed: [] });
    for (const email of [`invited-${f.learner.email}`, other]) {
      expect((await learnerBalance(f.org.id, email)).grantedSeconds).toBe(2700);
    }
    expect(await db.invitation.findMany({ where: { organizationId: f.org.id }, select: { email: true, role: true } })).toEqual(expect.arrayContaining([
      { email: `invited-${f.learner.email}`, role: "user" }, { email: other, role: "user" },
    ]));
    expect((await rows()).filter((row) => row.type === "grant")).toHaveLength(2);
    expect((await rows()).filter((row) => row.type === "grant").every((row) => row.actorUserId === f.trainer.id)).toBe(true);
    // The balance is now zero: a default 30-minute second grant would have made the hook fail.
    await beforeCreateInvitation({ invitation: { role: "user", email: `invited-${f.learner.email}`.toUpperCase(), inviterId: f.trainer.id }, organization: { id: f.org.id } });
    expect((await learnerBalance(f.org.id, `invited-${f.learner.email}`)).grantedSeconds).toBe(2700);
  });

  test("invite defaults to 30 and keeps an existing person's chosen grant on repeat", async () => {
    await fund(30);
    expect(await caller().invite({ emails: [`invited-${f.learner.email}`] })).toMatchObject({ invited: 1, failed: [] });
    const before = await rows();
    expect(await caller().invite({ emails: [`invited-${f.learner.email}`], minutes: 60 })).toMatchObject({ invited: 1, failed: [] });
    expect(await rows()).toEqual(before);
    expect((await learnerBalance(f.org.id, `invited-${f.learner.email}`)).grantedSeconds).toBe(1800);
  });

  test.each(["admin", "team"])("invite refuses %s studio emails before granting anyone or creating invitations", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await db.user.update({ where: { id: f.trainer.id }, data: { email: f.trainer.email.toUpperCase() } });
    await fund(100);
    const before = await rows();
    await expect(caller().invite({ emails: [`invited-${f.learner.email}`, f.trainer.email], minutes: 45 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("studio team") });
    expect(await rows()).toEqual(before);
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(headers).not.toHaveBeenCalled();
  });

  test("invite short balance writes nothing and creates no invitations", async () => {
    await fund(89);
    const before = await rows();
    await expect(caller().invite({ emails: [`invited-${f.learner.email}`, `other-${f.learner.email}`], minutes: 45 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rows()).toEqual(before);
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(headers).not.toHaveBeenCalled();
  });

  test("invite reports a per-email creation failure and continues with the remaining emails", async () => {
    const failedEmail = f.learner.email; // Already a member: invitation creation is refused.
    const invitedEmail = `invited-${f.learner.email}`;
    await fund(90);
    expect(await caller().invite({ emails: [failedEmail, invitedEmail], minutes: 45 })).toMatchObject({
      invited: 1, failed: [{ email: failedEmail, message: "User is already an organization member" }],
    });
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(1);
    for (const email of [failedEmail, invitedEmail]) expect((await learnerBalance(f.org.id, email)).grantedSeconds).toBe(2700);
  });

  test.each([0, -1, 1.5, 361])("invite validates amount %d before grants or invitations", async (minutes) => {
    await expect(caller().invite({ emails: [`invited-${f.learner.email}`], minutes })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rows()).toEqual([]);
  });
});
