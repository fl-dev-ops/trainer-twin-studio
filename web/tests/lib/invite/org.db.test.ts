import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fundOrg } from "../../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../minutes-test-db";
import { inviteOrgLearners, inviteLearners, inviteLearnerByApi, InviteError } from "@/lib/invite/org";
import { learnerInviteUrl } from "@/lib/invite/links";
import * as delivery from "@/lib/schedule-invite-emails";
import { MinutesError } from "@/lib/minutes";

describe.skipIf(!localMinutesDb)("invite/org: shared learner invitation writes", () => {
  let f: MinutesFixture;
  let queue: ReturnType<typeof spyOn<typeof delivery, "queueInviteEmails">>;
  let send: ReturnType<typeof spyOn<typeof delivery, "deliverInviteEmail">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    queue = spyOn(delivery, "queueInviteEmails").mockResolvedValue({ emailFailures: 0, emailsQueued: 1 });
    send = spyOn(delivery, "deliverInviteEmail").mockResolvedValue({ sent: true, queued: false });
  });
  afterEach(async () => { queue?.mockRestore(); send?.mockRestore(); await f.clean(); });
  const input = (emails = [`new-${f.learner.email}`], minutes = 30) => ({ org: f.org, by: f.trainer, emails, minutes });
  const invitations = () => db.invitation.findMany({ where: { organizationId: f.org.id } });
  const grants = () => db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" } });

  test("studio email refusal precedes all grants and invitations", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const error = await inviteOrgLearners(input([`new-${f.learner.email}`, f.trainer.email.toUpperCase()])).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MinutesError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining("studio team") });
    expect(await grants()).toEqual([]);
    expect(await invitations()).toEqual([]);
    expect(queue).not.toHaveBeenCalled();
  });
  test("short batch credits are all-or-nothing before invitations or delivery", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 59 });
    await expect(inviteLearners(input([`a-${f.learner.email}`, `b-${f.learner.email}`]))).rejects.toMatchObject({ name: "MinutesError", status: 409 });
    expect(await grants()).toEqual([]);
    expect(await invitations()).toEqual([]);
    expect(queue).not.toHaveBeenCalled();
  });
  test("normalizes once, refreshes pending invitations without duplicating grants, and keys emails by expiry", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    const email = `new-${f.learner.email}`;
    const before = Date.now();
    const result = await inviteOrgLearners(input([` ${email.toUpperCase()} `, email]));
    const [invitation] = await invitations();
    expect(result).toEqual({ invited: 1, failed: [], emails: [{
      kind: "invitation", idempotencyKey: `invitation:${invitation.id}:${invitation.expiresAt.getTime()}`,
      args: { to: email, organizationName: f.org.name, inviterName: f.trainer.name, inviteUrl: learnerInviteUrl(f.org.slug) },
    }] });
    expect(invitation).toMatchObject({ email, role: "user", status: "pending", inviterId: f.trainer.id });
    expect(invitation.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 48 * 60 * 60 * 1000);
    expect(invitation.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 48 * 60 * 60 * 1000);
    await db.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(0), inviterId: f.learner.id } });
    const refreshed = await inviteOrgLearners(input([email], 60));
    expect(await invitations()).toHaveLength(1);
    expect((await invitations())[0]).toMatchObject({ id: invitation.id, inviterId: f.trainer.id, expiresAt: expect.any(Date) });
    expect((await invitations())[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(refreshed.emails[0].idempotencyKey).toBe(`invitation:${invitation.id}:${(await invitations())[0].expiresAt.getTime()}`);
    expect(await grants()).toHaveLength(1);
    expect(queue).not.toHaveBeenCalled();
  });
  test.each([false, true])("member disabled=%s is a per-email failure; other recipients still get invited", async (disabled) => {
    await fundOrg({ orgId: f.org.id, minutes: 60 });
    if (disabled) await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const email = `new-${f.learner.email}`;
    const result = await inviteOrgLearners(input([f.learner.email, email]));
    expect(result).toMatchObject({ invited: 1, failed: [{ email: f.learner.email, message: expect.stringContaining(disabled ? "disabled" : "already") }] });
    expect(result.emails.map((email) => email.args.to)).toEqual([email]);
    expect(await invitations()).toHaveLength(1);
    expect(await grants()).toHaveLength(2); // Later invite refusals do not refund the committed starting grants.
  });
  test("direct inviteLearners queues the returned invitation batch once", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    expect(await inviteLearners(input())).toEqual({ invited: 1, failed: [], emailFailures: 0, emailsQueued: 1 });
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0]).toEqual([f.org.id, [expect.objectContaining({ kind: "invitation", args: expect.objectContaining({ to: input().emails[0] }) })]]);
  });
  test("inviteLearnerByApi creates then refreshes, preserves starting credits, and reports inline send status", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    const email = input().emails[0];
    const apiInput = { org: f.org, actorUserId: f.trainer.id, email: email.toUpperCase() };
    const first = await inviteLearnerByApi(apiInput);
    expect(first).toMatchObject({ created: true, emailSent: true, invitation: { email, role: "user", inviterId: f.trainer.id } });
    expect(send).toHaveBeenLastCalledWith({ kind: "invitation", idempotencyKey: `invitation:${first.invitation.id}:${first.invitation.expiresAt.getTime()}`, args: {
      to: email, organizationName: f.org.name, inviterName: f.trainer.name, inviteUrl: learnerInviteUrl(f.org.slug),
    } });
    send.mockResolvedValue({ sent: false, queued: true });
    expect(await inviteLearnerByApi({ ...apiInput, actorUserId: undefined })).toMatchObject({ created: false, emailSent: false, invitation: { id: first.invitation.id } });
    expect(await invitations()).toHaveLength(1);
    expect(await grants()).toHaveLength(1);
    expect(queue).not.toHaveBeenCalled();
  });
  test("inviteLearnerByApi keeps member/disabled, missing creator, and credit refusals", async () => {
    const run = (email: string, actorUserId = f.trainer.id) => inviteLearnerByApi({ org: f.org, actorUserId, email });
    expect(await run(f.learner.email).catch((error: unknown) => error)).toBeInstanceOf(InviteError);
    await expect(run(f.learner.email)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already") });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    await expect(run(f.learner.email)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("disabled") });
    await expect(run(input().emails[0], "missing")).rejects.toMatchObject({ status: 403 });
    await expect(run(input().emails[0])).rejects.toMatchObject({ status: 409 });
    expect(await invitations()).toEqual([]);
    expect(await grants()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
