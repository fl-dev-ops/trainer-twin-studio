import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as email from "@/lib/email";
import { inviteToRoleplay } from "@/lib/invite/roleplay";
import { grantMinutes, learnerBalance } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("inviteToRoleplay email minutes (local database)", () => {
  let f: MinutesFixture;
  let assignmentEmail: ReturnType<typeof spyOn<typeof email, "sendRolePlayAssignmentEmail">>;
  beforeEach(async () => {
    assignmentEmail = spyOn(email, "sendRolePlayAssignmentEmail").mockResolvedValue({ success: true });
    f = minutesFixture();
    await f.create();
  });
  afterEach(async () => { assignmentEmail?.mockRestore(); await f.clean(); });
  const fund = (minutes: number) => fundOrg({ orgId: f.org.id, minutes, note: "test" });
  const invite = (emails = [f.learner.email], startingMinutes?: number, resendPending?: boolean) =>
    inviteToRoleplay({ org: f.org, by: f.trainer, agent: f.roleplay, emails, startingMinutes, resendPending });

  test("each recipient's email includes their balance after starting credits are given", async () => {
    await fund(95);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 30 });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 5 });
    const newcomer = `new-${f.learner.email}`;
    expect(await invite([f.learner.email, newcomer])).toMatchObject({ added: 2, emailFailures: 0 });
    expect(assignmentEmail).toHaveBeenCalledTimes(2);
    for (const [to, minutes] of [[f.learner.email, 35], [newcomer, 30]] as const) {
      expect((await learnerBalance(f.org.id, to)).balanceSeconds).toBe(minutes * 60);
      expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to, minutes }));
    }
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, email: f.learner.email, type: "grant" } })).toBe(2);
  });

  test("custom startingMinutes appears in the new learner's email", async () => {
    await fund(12);
    expect(await invite([f.learner.email], 12)).toMatchObject({ added: 1, emailFailures: 0 });
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(720);
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, minutes: 12 }));
  });

  test.each([
    { usedSeconds: 91, expectedMinutes: 28 },
    { usedSeconds: 1861, expectedMinutes: 0 },
  ])("resend floors and clamps balance after $usedSeconds seconds of usage", async ({ usedSeconds, expectedMinutes }) => {
    await fund(30);
    await invite();
    const grants = await db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" } });
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await f.session({ startedAt, endedAt: new Date(startedAt.getTime() + usedSeconds * 1000), allowedSeconds: usedSeconds });
    assignmentEmail.mockClear();
    expect(await invite([f.learner.email], undefined, true)).toMatchObject({ resent: 1, emailFailures: 0 });
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, minutes: expectedMinutes }));
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" } })).toEqual(grants);
  });
});
