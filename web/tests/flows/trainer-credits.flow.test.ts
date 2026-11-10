import { fundOrg } from "../setup/meteroid";
import "./flow-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inviteToRoleplay } from "@/lib/invite/roleplay";
import { creditsLeftFor } from "@/lib/minutes";
import { minutesRouter } from "@/lib/minutes-trpc";
import { startSessionNow } from "@/lib/session-activation";
import { twinRouter } from "@/lib/twin/trpc";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { agentWebhook, outsideServices, practiceCode } from "./harness";

/** One trainer's funded org: invite, assign, add singly and in bulk, then a learner spends only their own credits. */
describe.skipIf(!localMinutesDb)("flow: trainer gives learners credits → learner practises", () => {
  const f = minutesFixture();
  const outside = outsideServices();
  const ctx = { user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } };
  const api = minutesRouter.createCaller(ctx);
  const twin = twinRouter.createCaller(ctx);
  const first = `first-${f.learner.email}`;
  const second = `second-${f.learner.email}`;
  const twinEmail = `twin-${f.learner.email}`;
  const rows = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
  let code = "";

  beforeAll(async () => {
    outside.start();
    await f.create();
    // Learner invites now write invitations directly; no Better Auth request headers are needed.
  });
  afterAll(async () => {
    await f.clean();
    outside.stop();
  });

  test("1. minutes.org starts empty; TrainerTwin funds 600 credits", async () => {
    expect(await api.org()).toMatchObject({ balanceMinutes: 0, addedMinutes: 0, learners: [] });
    await fundOrg({ orgId: f.org.id, minutes: 600, note: "Trainer credit story" });
    expect(await api.org()).toMatchObject({ balanceMinutes: 600, addedMinutes: 600 });
  });

  test("2. invite two new learners with 45 each, creating invitations and sending real captured emails", async () => {
    expect(await api.invite({ emails: [first, second], minutes: 45 })).toMatchObject({ invited: 2, failed: [] });
    expect(await db.invitation.findMany({ where: { organizationId: f.org.id }, select: { email: true, role: true, status: true } })).toEqual(expect.arrayContaining([
      { email: first, role: "user", status: "pending" }, { email: second, role: "user", status: "pending" },
    ]));
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(2);
    for (const email of [first, second]) {
      expect(await api.learner({ email })).toMatchObject({ givenMinutes: 45, balanceMinutes: 45 });
      expect(outside.emails.find((sent) => sent.to.includes(email))?.html).toContain(f.org.slug);
    }
    expect((await api.org()).balanceMinutes).toBe(510);
  });

  test("3. role-play assignment gives a new email 20 but preserves an already-credited learner's 45", async () => {
    expect(await inviteToRoleplay({ org: f.org, by: f.trainer, agent: f.roleplay, emails: [f.learner.email, first], startingMinutes: 20 })).toMatchObject({ added: 2, emailFailures: 0 });
    expect(await api.learner({ email: f.learner.email })).toMatchObject({ givenMinutes: 20, balanceMinutes: 20 });
    expect(await api.learner({ email: first })).toMatchObject({ givenMinutes: 45, balanceMinutes: 45 });
    expect((await api.org()).balanceMinutes).toBe(490);
    const email = outside.emails.find((sent) => sent.to.includes(f.learner.email))!;
    expect(email.text).toContain("You have 20 minutes");
    code = practiceCode(email);
  });

  test("4. twin tRPC assignment gives 15; the captured email says You have 15 minutes", async () => {
    expect(await twin.assignments.assign({ slug: f.twin.slug, emails: [twinEmail], startingMinutes: 15 })).toMatchObject({ added: 1, emailFailures: 0 });
    expect(await db.twinAssignment.findFirst({ where: { orgId: f.org.id, recipientEmail: twinEmail } })).toMatchObject({ status: "active" });
    expect(await api.learner({ email: twinEmail })).toMatchObject({ givenMinutes: 15, balanceMinutes: 15 });
    expect(outside.emails.find((email) => email.to.includes(twinEmail))?.text).toContain("You have 15 minutes");
    expect((await api.org()).balanceMinutes).toBe(475);
  });

  test("5. add 30 with trainer attribution; refuse past 360 and refuse studio members without writes", async () => {
    expect(await api.add({ email: first, minutes: 30 })).toEqual({ grantedMinutes: 30, balanceMinutes: 75, orgBalanceMinutes: 445 });
    expect((await api.learner({ email: first })).added).toContainEqual(expect.objectContaining({ minutes: 30, note: "Added by trainer", by: f.trainer.name }));
    expect(await db.minuteLedger.findFirst({ where: { orgId: f.org.id, email: first, note: "Added by trainer" } })).toMatchObject({ actorUserId: f.trainer.id });
    const before = await rows();
    await expect(api.add({ email: first, minutes: 286 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("360 minutes in total") });
    await expect(api.add({ email: f.trainer.email, minutes: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("studio team") });
    expect(await rows()).toEqual(before);
    await api.add({ email: second, minutes: 300 });
    expect((await api.org()).balanceMinutes).toBe(145);
  });

  test("6. bulk add skips the capped learner with a reason and charges exactly the other two grants", async () => {
    expect(await api.addMany({ emails: [first, second, f.learner.email], minutes: 20 })).toEqual({
      given: [first, f.learner.email], skipped: [{ email: second, reason: expect.stringContaining("15 more") }], orgBalanceMinutes: 105,
    });
    expect(await api.learner({ email: second })).toMatchObject({ givenMinutes: 345 });
    expect(await api.learner({ email: first })).toMatchObject({ givenMinutes: 95 });
    expect(await api.learner({ email: f.learner.email })).toMatchObject({ givenMinutes: 40 });
  });

  test("7. short balance is a 409 for one learner and all-or-nothing for bulk", async () => {
    const before = await rows();
    await expect(api.add({ email: first, minutes: 106 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(api.addMany({ emails: [first, f.learner.email], minutes: 60 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rows()).toEqual(before);
    expect((await api.org()).balanceMinutes).toBe(105);
  });

  test("8. org learner totals match creditsLeftFor; a 3-minute call reduces only the learner's credits", async () => {
    const expected = new Map([[first, 95], [second, 345], [f.learner.email, 40], [twinEmail, 15]]);
    const org = await api.org();
    expect(org.learners).toHaveLength(4);
    const left = await creditsLeftFor(f.org.id, [...expected.keys(), f.trainer.email]);
    expect(left.get(f.trainer.email)).toBeNull();
    for (const row of org.learners) {
      expect(row).toMatchObject({ givenMinutes: expected.get(row.email), usedMinutes: 0, leftMinutes: expected.get(row.email) });
      expect(left.get(row.email)).toEqual({ left: row.leftMinutes, given: row.givenMinutes });
    }
    const call = await startSessionNow({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: code, mode: "voice" });
    if (!call.ok) throw new Error(call.error);
    expect(call?.session.secondsLeft).toBe(2400);
    expect(outside.livekit).toContain("CreateDispatch");
    expect(outside.chatSessions).toContain(call!.session.id);
    await db.interviewSession.update({ where: { id: call!.session.id }, data: { startedAt: new Date(Date.now() - 180_000) } });
    expect((await agentWebhook(call!.session.id)).status).toBe(200);
    expect(await api.learner({ email: f.learner.email })).toMatchObject({ givenMinutes: 40, usedMinutes: 3, balanceMinutes: 37 });
    expect((await api.org()).balanceMinutes).toBe(org.balanceMinutes);
    expect((await api.org()).learners.find((row) => row.email === f.learner.email)).toMatchObject({ givenMinutes: 40, usedMinutes: 3, leftMinutes: 37 });
    expect((await creditsLeftFor(f.org.id, [f.learner.email])).get(f.learner.email)).toEqual({ left: 37, given: 40 });
    expect(outside.unexpected).toEqual([]);
  });
});
