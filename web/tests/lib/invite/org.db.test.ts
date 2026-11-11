import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fundOrg } from "../../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../minutes-test-db";
import { NOTHING_BROKEN, peopleRulesBroken, removeAccountsOf } from "../people-test-db";
import { addLearnerByApi, addOrgPeople, addOrgPeopleAndEmail } from "@/lib/invite/org";
import { signInUrl } from "@/lib/invite/links";
import * as delivery from "@/lib/queue-emails";
import { MinutesError } from "@/lib/minutes";

// Settings › Team / Users and POST /api/v1/users (specs/people.md rules 2, 6, 7, 11): people become members at once,
// no invitations, and each new member gets one "added" email keyed by their membership.
describe.skipIf(!localMinutesDb)("invite/org: adding people to an org (local database)", () => {
  let f: MinutesFixture;
  let queue: ReturnType<typeof spyOn<typeof delivery, "queueEmails">>;
  let send: ReturnType<typeof spyOn<typeof delivery, "deliverEmail">>;
  const email = (name: string) => `${name}-${f.org.id}@example.com`;
  const input = (emails: string[], role: "admin" | "team" | "user" = "user", minutes?: number) => ({ org: f.org, by: f.trainer, emails, role, minutes });
  const grants = () => db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" } });
  const invitations = () => db.invitation.findMany({ where: { organizationId: f.org.id } });
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    queue = spyOn(delivery, "queueEmails").mockResolvedValue({ emailFailures: 0, emailsQueued: 1 });
    send = spyOn(delivery, "deliverEmail").mockResolvedValue({ sent: true });
  });
  afterEach(async () => { queue?.mockRestore(); send?.mockRestore(); await f.clean(); await removeAccountsOf(f.org.id); });

  test("new learners become members with starting credits; one 'added' email each, keyed by membership", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const result = await addOrgPeople(input([email("a").toUpperCase(), email("a"), f.learner.email]));
    expect(result).toMatchObject({ added: 1, already: 1 });
    const member = await db.member.findFirstOrThrow({ where: { organizationId: f.org.id, user: { email: email("a") } } });
    expect(member.role).toBe("user");
    expect(result.emails).toEqual([{
      kind: "person", idempotencyKey: `added:${member.id}`,
      args: {
        to: email("a"), orgName: f.org.name, byName: f.trainer.name,
        added: { role: "user", signInUrl: signInUrl("user", f.org.slug) },
        credits: { added: 30, balance: 30 },
      },
    }]);
    expect(await invitations()).toEqual([]);
    expect(queue).not.toHaveBeenCalled();
    expect(await peopleRulesBroken(f.org.id)).toEqual(NOTHING_BROKEN);
  });

  test.each(["team", "admin"] as const)("%s people are added straight away (no invitation), told to sign in to the studio, no credits", async (role) => {
    if (role === "admin") await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role: "team" } });
    const result = await addOrgPeople(input([email("coach")], role));
    expect(result.added).toBe(1);
    expect(result.emails).toEqual([expect.objectContaining({ args: expect.objectContaining({ added: { role, signInUrl: signInUrl(role, f.org.slug) } }) })]);
    expect(result.emails[0].args).not.toHaveProperty("credits");
    expect(await grants()).toEqual([]);
    expect(await invitations()).toEqual([]);
  });

  test("people already in the org get no email; a second admin and short credits are refused with nothing written", async () => {
    expect(await addOrgPeople(input([f.trainer.email], "team"))).toEqual({ added: 0, already: 1, emails: [] });
    await expect(addOrgPeople(input([email("boss")], "admin"))).rejects.toMatchObject({ name: "PeopleError", code: "one_admin", status: 409 });
    await fundOrg({ orgId: f.org.id, minutes: 59 });
    await expect(addOrgPeople(input([email("x"), email("y")]))).rejects.toBeInstanceOf(MinutesError);
    expect(await db.member.count({ where: { organizationId: f.org.id } })).toBe(2);
    expect(await grants()).toEqual([]);
  });

  test("addOrgPeopleAndEmail queues exactly the returned emails once", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    expect(await addOrgPeopleAndEmail(input([email("q")]))).toEqual({ added: 1, already: 0, emailFailures: 0, emailsQueued: 1 });
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0]).toEqual([f.org.id, [expect.objectContaining({ kind: "person", args: expect.objectContaining({ to: email("q") }) })]]);
  });

  test("addLearnerByApi adds then returns the same person unchanged; emails only the first time", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    const run = () => addLearnerByApi({ org: f.org, by: { userId: f.trainer.id, name: f.trainer.name }, email: email("api").toUpperCase() });
    const first = await run();
    expect(first).toMatchObject({ created: true, emailSent: true, person: { email: email("api"), role: "user", added: true } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ kind: "person", idempotencyKey: `added:${first.person.memberId}`, args: { to: email("api"), byName: f.trainer.name, added: { role: "user" } } });
    const again = await run();
    expect(again).toMatchObject({ created: false, emailSent: false, person: { memberId: first.person.memberId } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await grants()).toHaveLength(1);
    expect(await invitations()).toEqual([]);
  });

  test("addLearnerByApi refuses studio and disabled people, and short credits", async () => {
    const run = (target: string) => addLearnerByApi({ org: f.org, by: { userId: f.trainer.id, name: f.trainer.name }, email: target });
    await expect(run(f.trainer.email)).rejects.toMatchObject({ name: "PeopleError", status: 409 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    await expect(run(f.learner.email)).rejects.toMatchObject({ name: "PeopleError", status: 409, message: expect.stringContaining("disabled") });
    await expect(run(email("n"))).rejects.toMatchObject({ name: "MinutesError", status: 409 });
    expect(send).not.toHaveBeenCalled();
    expect(await grants()).toEqual([]);
  });
});
