import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as email from "@/lib/email";
import { assignRoleplayLearners, inviteToRoleplay } from "@/lib/invite/roleplay";
import { grantMinutes, learnerBalance } from "@/lib/minutes";
import { orgPerson } from "@/lib/org-people";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { NOTHING_BROKEN, peopleRulesBroken, removeAccountsOf } from "./people-test-db";

// Role-play assign (specs/people.md rules 3, 6, 11): add people first, then an assignment on their member, then one email
// each with the balance after their starting credits.
describe.skipIf(!localMinutesDb)("role-play assign (local database)", () => {
  let f: MinutesFixture;
  let personEmail: ReturnType<typeof spyOn<typeof email, "sendPersonEmail">>;
  let log: ReturnType<typeof spyOn<typeof console, "error">>;
  beforeEach(async () => {
    personEmail = spyOn(email, "sendPersonEmail").mockResolvedValue({ success: true });
    log = spyOn(console, "error").mockImplementation(() => {}); // the workflow can't start in tests: sent inline
    f = minutesFixture();
    await f.create();
  });
  afterEach(async () => { personEmail?.mockRestore(); log?.mockRestore(); await f.clean(); await removeAccountsOf(f.org.id); });
  const fund = (minutes: number) => fundOrg({ orgId: f.org.id, minutes, note: "test" });
  const input = (emails = [f.learner.email], startingMinutes?: number, resendPending?: boolean) =>
    ({ org: f.org, by: f.trainer, agent: { ...f.roleplay, data: { objective: "Close the deal" } }, emails, startingMinutes, resendPending });
  const newcomer = () => `new-${f.org.id}@example.com`;

  test("each person's one email has their balance after starting credits; a newcomer's also says 'added'", async () => {
    await fund(95);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 30 });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 5 });
    expect(await inviteToRoleplay(input([f.learner.email, newcomer()]))).toMatchObject({ added: 2, joined: 1, emailFailures: 0 });
    expect(personEmail).toHaveBeenCalledTimes(2);
    for (const [to, balance, added] of [[f.learner.email, 35, false], [newcomer(), 30, true]] as const) {
      expect((await learnerBalance(f.org.id, to)).balanceSeconds).toBe(balance * 60);
      const args = personEmail.mock.calls.find(([a]) => a.to === to)![0];
      expect(args.credits?.balance).toBe(balance);
      expect(Boolean(args.added)).toBe(added);
      expect(args.roleplay).toMatchObject({ name: f.roleplay.name, objective: "Close the deal" });
    }
    // Each assignment points at the person's member, never at an email.
    const person = (await orgPerson(f.org.id, { email: newcomer() }))!;
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id, memberId: person.memberId } })).toBe(1);
    expect(await peopleRulesBroken(f.org.id)).toEqual(NOTHING_BROKEN);
  });

  test("keys: roleplay:<shareCode>; a pending one is skipped, or re-sent on request with a new key; cancelled gets a new link", async () => {
    await fund(30);
    const first = await assignRoleplayLearners(input());
    const row = await db.rolePlayAssignment.findFirstOrThrow({ where: { orgId: f.org.id, memberId: `${f.learner.id}-member` } });
    expect(first.emails.map((e) => e.idempotencyKey)).toEqual([`roleplay:${row.shareCode}`]);
    expect(first.emails[0].args).not.toHaveProperty("added");
    expect(await assignRoleplayLearners(input())).toMatchObject({ stats: { added: 0, skipped: 1 }, emails: [] });
    const resent = await assignRoleplayLearners(input([f.learner.email], undefined, true));
    expect(resent.stats).toMatchObject({ resent: 1 });
    expect(resent.emails[0].idempotencyKey).toMatch(new RegExp(`^roleplay:${row.shareCode}:resend:\\d+$`));
    await db.rolePlayAssignment.update({ where: { id: row.id }, data: { status: "cancelled" } });
    const reopened = await assignRoleplayLearners(input());
    const after = await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "pending" });
    expect(after.shareCode).not.toBe(row.shareCode);
    expect(reopened.emails.map((e) => e.idempotencyKey)).toEqual([`roleplay:${after.shareCode}`]);
  });

  test("custom startingMinutes appears in the new learner's email", async () => {
    await fund(12);
    expect(await inviteToRoleplay(input([f.learner.email], 12))).toMatchObject({ added: 1, emailFailures: 0 });
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(720);
    expect(personEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, credits: { added: 12, balance: 12 } }));
  });

  test("studio people and disabled members are refused before anything is written", async () => {
    await fund(100);
    await expect(inviteToRoleplay(input([newcomer(), f.trainer.email]))).rejects.toMatchObject({ name: "PeopleError", status: 409 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    await expect(inviteToRoleplay(input([f.learner.email]))).rejects.toMatchObject({ name: "PeopleError", status: 409 });
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(personEmail).not.toHaveBeenCalled();
  });

  test.each([
    { usedSeconds: 91, expectedMinutes: 28 },
    { usedSeconds: 1861, expectedMinutes: 0 },
  ])("resend floors and clamps balance after $usedSeconds seconds of usage", async ({ usedSeconds, expectedMinutes }) => {
    await fund(30);
    await inviteToRoleplay(input());
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await f.session({ startedAt, endedAt: new Date(startedAt.getTime() + usedSeconds * 1000), allowedSeconds: usedSeconds });
    personEmail.mockClear();
    expect(await inviteToRoleplay(input([f.learner.email], undefined, true))).toMatchObject({ resent: 1, emailFailures: 0 });
    expect(personEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, credits: { added: undefined, balance: expectedMinutes } }));
  });
});
