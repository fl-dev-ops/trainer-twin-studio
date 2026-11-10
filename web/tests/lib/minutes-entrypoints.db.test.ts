import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as email from "@/lib/email";
import { auth } from "@/lib/auth";
import { grantMinutes, learnerBalance } from "@/lib/minutes";
import { inviteToRoleplay } from "@/lib/invite/roleplay";
import { assignTwinAndInvite } from "@/lib/invite/twin";
import { createTwinShareLink, twinAccessByCode } from "@/lib/twin-access";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("starting minutes entrypoints (local database)", () => {
  let f: MinutesFixture;
  let personEmail: ReturnType<typeof spyOn<typeof email, "sendPersonEmail">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    personEmail = spyOn(email, "sendPersonEmail").mockResolvedValue({ success: true });
  });
  afterEach(async () => { personEmail?.mockRestore(); await f.clean(); });
  const fund = (amount = 60) => fundOrg({ orgId: f.org.id, minutes: amount, note: "test" });
  const invite = (emails = [f.learner.email]) => inviteToRoleplay({ org: f.org, by: f.trainer, agent: f.roleplay, emails });
  const assign = (emails = [f.learner.email]) => assignTwinAndInvite({ org: f.org, by: f.trainer, agent: f.twin, emails });

  test("role-play invite grants 30 once, reused by twin assignment and repeated invitations", async () => {
    await fund(30);
    expect(await invite([f.learner.email.toUpperCase(), f.learner.email])).toMatchObject({ added: 1 });
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(1800);
    expect(await assign()).toMatchObject({ added: 1 });
    expect(await invite()).toMatchObject({ skipped: 1 });
    expect(await assign()).toMatchObject({ skipped: 1 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect(personEmail).toHaveBeenCalledTimes(2);
    expect(personEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, credits: { added: undefined, balance: 30 } }));
  });

  test("twin assignment gives 30 once and emails the learner's actual balance", async () => {
    await fund();
    expect(await assign()).toMatchObject({ added: 1 });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 5 });
    await db.twinAssignment.updateMany({ where: { orgId: f.org.id }, data: { status: "revoked" } });
    expect(await assign()).toMatchObject({ reactivated: 1 });
    expect(personEmail).toHaveBeenLastCalledWith(expect.objectContaining({ credits: { added: undefined, balance: 35 } }));
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, note: "Starting minutes" } })).toBe(1);
  });

  test.each(["roleplay", "twin"])("%s batch refuses short balance before creating assignments or sending mail", async (kind) => {
    await fund(59);
    const emails = [f.learner.email, `other-${f.learner.email}`];
    await expect(kind === "twin" ? assign(emails) : invite(emails)).rejects.toMatchObject({ name: "MinutesError", status: 409 });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(personEmail).not.toHaveBeenCalled();
  });

  test("share-link preview grants nothing; short join creates nothing; funded/repeated join grants once", async () => {
    const link = await createTwinShareLink({ orgId: f.org.id, agentId: f.twin.id, minutesPerUser: 999, createdByUserId: f.trainer.id });
    const input = { orgId: f.org.id, user: f.learner, code: link.code };
    expect(await twinAccessByCode({ ...input, join: false })).toEqual({ assignmentId: null, agentId: f.twin.id });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    await expect(twinAccessByCode({ ...input, join: true })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("Not enough credits") });
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    await fund(30);
    const joined = await twinAccessByCode({ ...input, join: true });
    expect(await twinAccessByCode({ ...input, join: true })).toEqual(joined);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(1);
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(1800); // legacy link limit is ignored
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
  });

  test.each(["admin", "team", "user"])("Better Auth refuses invitations for %s without writing credits or members", async (role) => {
    const plugin = auth.options.plugins.find((p) => p.id === "organization") as any;
    await expect(plugin.options.organizationHooks.beforeCreateInvitation({ invitation: { role, email: f.learner.email, inviterId: f.trainer.id }, organization: { id: f.org.id } }))
      .rejects.toMatchObject({ status: "FORBIDDEN", body: { message: expect.stringContaining("Add people from Settings") } });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
  });
});
