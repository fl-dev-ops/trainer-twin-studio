import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { NOTHING_BROKEN, peopleRulesBroken, removeAccountsOf } from "./people-test-db";
import * as delivery from "@/lib/queue-emails";
import { signInUrl } from "@/lib/invite/links";
import { assignTwinAndInvite, assignTwinLearners } from "@/lib/invite/twin";
import { createTwinShareLink, twinAccessByAgent, twinAccessByCode, TwinAccessError, twinShareUrl } from "@/lib/twin-access";
import { AppError } from "@/lib/errors";
import { orgPerson } from "@/lib/org-people";

// Twin access is by account (specs/people.md rule 4); a shared link adds the person to the org first (rule 6), with no
// email (rule 11); assigning adds people, then the twin, then one email each.
describe.skipIf(!localMinutesDb)("twin access and twin assign (local database)", () => {
  let f: MinutesFixture;
  let queue: ReturnType<typeof spyOn<typeof delivery, "queueEmails">>;
  let send: ReturnType<typeof spyOn<typeof delivery, "deliverEmail">>;
  const email = (name: string) => `${name}-${f.org.id}@example.com`;
  const stranger = () => ({ id: `${f.org.id}-stranger`, email: email("stranger") });
  const assign = (emails: string[], accessUntil?: Date | null) =>
    assignTwinLearners({ org: f.org, by: f.trainer, agent: { id: f.twin.id, name: f.twin.name }, emails, accessUntil });
  const rejects = async (promise: Promise<unknown>, status: number, message: string | RegExp) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(message === "Your access to this organization has been turned off. Ask its admin to turn it back on." ? AppError : TwinAccessError);
    expect(error).toMatchObject({ status, message: expect.stringMatching(message) });
  };
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    await db.user.create({ data: { ...stranger(), name: "Stranger", emailVerified: true } });
    queue = spyOn(delivery, "queueEmails").mockResolvedValue({ emailFailures: 0, emailsQueued: 1 });
    send = spyOn(delivery, "deliverEmail").mockResolvedValue({ sent: true });
  });
  afterEach(async () => { queue?.mockRestore(); send?.mockRestore(); await f.clean(); await removeAccountsOf(f.org.id); });

  test("a brand-new learner given a twin: account, member, assignment, credits, and ONE email covering all of it", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const until = new Date(Date.now() + 7 * 86400_000);
    const { stats, emails } = await assign([email("new").toUpperCase()], until);
    expect(stats).toEqual({ added: 1, reactivated: 0, skipped: 0, joined: 1 });
    const person = (await orgPerson(f.org.id, { email: email("new") }))!;
    expect(person.role).toBe("user");
    const assignment = await db.twinAssignment.findFirstOrThrow({ where: { agentId: f.twin.id, userId: person.userId } });
    expect(assignment).toMatchObject({ status: "active", accessUntil: until, assignedByUserId: f.trainer.id });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toEqual({
      kind: "person", idempotencyKey: `twin:${assignment.shareCode}`,
      args: {
        to: email("new"), orgName: f.org.name, byName: f.trainer.name,
        added: { role: "user", signInUrl: signInUrl("user", f.org.slug) },
        twin: { name: f.twin.name, url: twinShareUrl(f.org.slug, "twin"), until: expect.any(String) },
        credits: { added: 30, balance: 30 },
      },
    });
    expect(queue).not.toHaveBeenCalled();
    expect(await peopleRulesBroken(f.org.id)).toEqual(NOTHING_BROKEN);
  });

  test("an existing learner gets the twin without 'added'; an active one is skipped with no email; a revoked one is restored with a new link", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const first = await assign([f.learner.email]);
    expect(first.stats).toMatchObject({ added: 1, joined: 0 });
    expect(first.emails[0].args).not.toHaveProperty("added");
    expect(first.emails[0].args).toHaveProperty("twin");
    expect(await assign([f.learner.email])).toEqual({ stats: { added: 0, reactivated: 0, skipped: 1, joined: 0 }, emails: [] });
    const row = await db.twinAssignment.findFirstOrThrow({ where: { agentId: f.twin.id, userId: f.learner.id } });
    await db.twinAssignment.update({ where: { id: row.id }, data: { status: "revoked" } });
    const restored = await assign([f.learner.email]);
    expect(restored.stats).toMatchObject({ reactivated: 1 });
    const after = await db.twinAssignment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.shareCode).not.toBe(row.shareCode);
    expect(restored.emails.map((e) => e.idempotencyKey)).toEqual([`twin:${after.shareCode}`]);
  });

  test("assigning refuses studio people and disabled members, with nothing written", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await expect(assign([email("x"), f.trainer.email])).rejects.toMatchObject({ name: "PeopleError", status: 409 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    await expect(assign([f.learner.email])).rejects.toMatchObject({ name: "PeopleError", status: 409 });
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await orgPerson(f.org.id, { email: email("x") })).toBeNull();
  });

  test("assignTwinAndInvite queues the emails once", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const result = await assignTwinAndInvite({ org: f.org, by: f.trainer, agent: { id: f.twin.id, name: f.twin.name }, emails: [email("q")] });
    expect(result).toMatchObject({ added: 1, joined: 1, emailsQueued: 1 });
    expect(queue).toHaveBeenCalledTimes(1);
  });

  test("a personal twin code opens only for its own account, in its own org, while active", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await assign([f.learner.email]);
    const row = await db.twinAssignment.findFirstOrThrow({ where: { agentId: f.twin.id, userId: f.learner.id } });
    const code = row.shareCode;
    expect(await twinAccessByCode({ orgId: f.org.id, user: f.learner, code, join: true })).toEqual({ assignmentId: row.id, agentId: f.twin.id });
    // Someone else, even with the learner's email in some other account, is refused: access is by account.
    await rejects(twinAccessByCode({ orgId: f.org.id, user: { id: stranger().id, email: f.learner.email }, code, join: true }), 403, "not assigned to your account");
    await rejects(twinAccessByCode({ orgId: "other-org", user: f.learner, code, join: true }), 403, "another organization");
    await db.twinAssignment.update({ where: { id: row.id }, data: { accessUntil: new Date(Date.now() - 1000) } });
    await rejects(twinAccessByCode({ orgId: f.org.id, user: f.learner, code, join: true }), 403, "has ended");
    await db.twinAssignment.update({ where: { id: row.id }, data: { status: "revoked", accessUntil: null } });
    await rejects(twinAccessByCode({ orgId: f.org.id, user: f.learner, code, join: true }), 403, "removed");
    expect(await twinAccessByCode({ orgId: f.org.id, user: f.learner, code: "not-a-code", join: true })).toBeNull();
  });

  test("a shared twin link: preview adds nobody; joining adds the account as a learner with the twin and credits, sends no email", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const link = await createTwinShareLink({ orgId: f.org.id, agentId: f.twin.id, minutesPerUser: 30, createdByUserId: f.trainer.id });
    expect(await twinAccessByCode({ orgId: f.org.id, user: stranger(), code: link.code, join: false })).toEqual({ assignmentId: null, agentId: f.twin.id });
    expect(await orgPerson(f.org.id, { userId: stranger().id })).toBeNull();
    const joined = await twinAccessByCode({ orgId: f.org.id, user: stranger(), code: link.code, join: true });
    expect(joined).toEqual({ assignmentId: expect.any(String), agentId: f.twin.id });
    expect(await orgPerson(f.org.id, { userId: stranger().id })).toMatchObject({ role: "user", disabled: false });
    expect(await db.twinAssignment.findUniqueOrThrow({ where: { id: joined!.assignmentId! } })).toMatchObject({ userId: stranger().id, shareLinkId: link.id });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, email: stranger().email, type: "grant" } })).toBe(1);
    // Opening it again reuses everything.
    expect(await twinAccessByCode({ orgId: f.org.id, user: stranger(), code: link.code, join: true })).toEqual(joined);
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: stranger().id } })).toBe(1);
    expect(queue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await peopleRulesBroken(f.org.id)).toEqual(NOTHING_BROKEN);
  });

  test("a shared twin link: studio people use it without an assignment; disabled members and disabled links are refused", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const link = await createTwinShareLink({ orgId: f.org.id, agentId: f.twin.id, minutesPerUser: 30, createdByUserId: f.trainer.id });
    expect(await twinAccessByCode({ orgId: f.org.id, user: f.trainer, code: link.code, join: true })).toEqual({ assignmentId: null, agentId: f.twin.id });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    await rejects(twinAccessByCode({ orgId: f.org.id, user: f.learner, code: link.code, join: true }), 403, "Your access to this organization has been turned off. Ask its admin to turn it back on.");
    await db.twinShareLink.update({ where: { id: link.id }, data: { status: "disabled" } });
    await rejects(twinAccessByCode({ orgId: f.org.id, user: stranger(), code: link.code, join: true }), 403, "no longer active");
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await orgPerson(f.org.id, { userId: stranger().id })).toBeNull();
  });

  test.each([false, true])("a disabled member's leftover active assignment cannot open a common twin link (join=%s)", async (join) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await assign([f.learner.email]);
    const assignment = await db.twinAssignment.findFirstOrThrow({ where: { agentId: f.twin.id, userId: f.learner.id } });
    expect(assignment.status).toBe("active");
    const link = await createTwinShareLink({ orgId: f.org.id, agentId: f.twin.id, minutesPerUser: 30, createdByUserId: f.trainer.id });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    await expect(twinAccessByCode({ orgId: f.org.id, user: f.learner, code: link.code, join })).rejects.toMatchObject({
      name: "AppError", code: "member_disabled", status: 403, message: "Your access to this organization has been turned off. Ask its admin to turn it back on.",
    });
    expect(await db.twinAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
    expect(await orgPerson(f.org.id, { userId: f.learner.id })).toMatchObject({ disabled: true });
  });

  test("a direct start needs the account's own assignment on that twin", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await assign([f.learner.email]);
    expect(await twinAccessByAgent({ orgId: f.org.id, user: f.learner, agentId: f.twin.id })).toMatchObject({ agentId: f.twin.id });
    await rejects(twinAccessByAgent({ orgId: f.org.id, user: stranger(), agentId: f.twin.id }), 403, "not assigned");
  });
});
