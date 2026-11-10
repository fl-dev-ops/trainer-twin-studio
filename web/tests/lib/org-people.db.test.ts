import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { NOTHING_BROKEN, peopleRulesBroken, removeAccountsOf } from "./people-test-db";
import { addPeopleToOrg, orgPeople, orgPerson, PeopleError, studioPeopleEmails } from "@/lib/org-people";
import { MinutesError } from "@/lib/minutes";

// specs/people.md rules 1, 2, 5, 7, 8, 9 against the real database.
describe.skipIf(!localMinutesDb)("org-people (local database)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture | undefined;
  const email = (name: string) => `${name}-${f.org.id}@example.com`;
  const add = (emails: string[], role: "admin" | "team" | "user" = "user", startingMinutes?: number) =>
    addPeopleToOrg({ orgId: f.org.id, emails, role, byUserId: f.trainer.id, startingMinutes });
  const grants = () => db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" }, orderBy: { email: "asc" } });
  const members = () => db.member.findMany({ where: { organizationId: f.org.id } });
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await other?.clean(); other = undefined; await f.clean(); await removeAccountsOf(f.org.id); });

  test("a new email gets an account (lower-cased, name before @), then a learner membership, then its starting credits", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const [person] = await add([`  ${email("Nina").toUpperCase()} `]);
    const user = await db.user.findUniqueOrThrow({ where: { id: person.userId } });
    expect(user).toMatchObject({ email: email("nina"), name: `nina-${f.org.id}`, emailVerified: false });
    expect(person).toMatchObject({ email: email("nina"), role: "user", added: true, startingCredits: 30, disabled: false });
    expect(await db.member.findUniqueOrThrow({ where: { id: person.memberId } })).toMatchObject({ organizationId: f.org.id, userId: user.id, role: "user" });
    expect((await grants()).map((g) => [g.email, g.seconds])).toEqual([[email("nina"), 1800]]);
    expect(await peopleRulesBroken(f.org.id)).toEqual(NOTHING_BROKEN);
  });

  test("an existing account from another org (any case) is reused, preserving both memberships", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const outsider = await db.user.create({ data: { id: `${f.org.id}-out`, name: "Out Sider", email: email("outsider"), emailVerified: true } });
    other = minutesFixture(); await other.create();
    await db.member.create({ data: { id: `${outsider.id}-other-member`, userId: outsider.id, organizationId: other.org.id, role: "team", createdAt: new Date() } });
    const [person] = await add([email("OUTSIDER")]);
    expect(await orgPerson(other.org.id, { userId: outsider.id })).toMatchObject({ role: "team" });
    expect(person).toMatchObject({ userId: outsider.id, name: "Out Sider", added: true });
    expect(await db.user.count({ where: { email: { equals: email("outsider"), mode: "insensitive" } } })).toBe(1);
  });

  test("duplicates in one batch become one member; adding again keeps one member and gives no more credits", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const first = await add([email("dup"), email("DUP"), ` ${email("dup")}`]);
    expect(first).toHaveLength(1);
    const again = await add([email("dup")]);
    expect(again).toEqual([expect.objectContaining({ memberId: first[0].memberId, added: false, startingCredits: 0 })]);
    expect((await members()).filter((m) => m.userId === first[0].userId)).toHaveLength(1);
    expect(await grants()).toHaveLength(1);
  });

  test("someone already in the org keeps their role (no role change through add)", async () => {
    const [team] = await add([email("coach")], "team");
    expect(team).toMatchObject({ role: "team", added: true, startingCredits: 0 });
    const [again] = await add([email("coach")], "team");
    expect(again).toMatchObject({ role: "team", added: false });
    // An existing learner added as team stays a learner.
    const [learner] = await add([f.learner.email], "team");
    expect(learner).toMatchObject({ role: "user", added: false });
    expect(await grants()).toEqual([]); // studio people never get learner credits
  });

  test.each(["admin", "team"])("a learner add refuses %s studio people, before anything is written", async (role) => {
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const error = await add([email("fresh"), f.trainer.email.toUpperCase()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeopleError);
    expect(error).toMatchObject({ status: 409, message: expect.stringContaining(f.trainer.email) });
    expect(await orgPerson(f.org.id, { email: email("fresh") })).toBeNull();
    expect(await grants()).toEqual([]);
  });

  test("one admin per org: a second admin is refused, two at once too; the existing admin re-added is fine", async () => {
    await expect(add([email("boss")], "admin")).rejects.toMatchObject({ name: "PeopleError", status: 403 });
    expect(await add([f.trainer.email], "admin")).toEqual([expect.objectContaining({ role: "admin", added: false })]);
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role: "team" } });
    await expect(add([email("a1"), email("a2")], "admin")).rejects.toMatchObject({ status: 403 });
    const [admin] = await add([email("a1")], "admin");
    expect(admin).toMatchObject({ role: "admin", added: true });
    expect(await orgPerson(f.org.id, { email: email("a2") })).toBeNull();
  });

  test("a disabled member stays disabled: adding them is refused (with how to fix it), nobody in the batch is added", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const error = await add([email("other"), f.learner.email]).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "PeopleError", status: 409, message: expect.stringContaining("re-enable") });
    expect(await orgPerson(f.org.id, { email: email("other") })).toBeNull();
    expect((await orgPerson(f.org.id, { userId: f.learner.id }))?.disabled).toBe(true);
    for (const role of ["team", "admin"] as const) await expect(add([f.learner.email], role)).rejects.toMatchObject({ status: 409 });
  });

  test("starting credits are all or nothing: when the org can't cover the batch, nobody is added", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 59 });
    const error = await add([email("a"), email("b")]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MinutesError);
    expect(error).toMatchObject({ status: 409 });
    expect(await orgPeople(f.org.id, { emails: [email("a"), email("b")], includeDisabled: true })).toEqual([]);
    expect(await db.user.count({ where: { email: { in: [email("a"), email("b")] } } })).toBe(0);
    expect(await grants()).toEqual([]);
  });

  test("invalid emails are refused before anything is written; an empty batch does nothing", async () => {
    await expect(add([email("ok"), "not-an-email"])).rejects.toMatchObject({ name: "PeopleError", status: 400, message: expect.stringContaining("not-an-email") });
    expect(await orgPerson(f.org.id, { email: email("ok") })).toBeNull();
    expect(await add(["", "  "])).toEqual([]);
  });

  test("custom starting credits are given and reported", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const [person] = await add([email("ten")], "user", 10);
    expect(person.startingCredits).toBe(10);
    expect((await grants()).map((g) => g.seconds)).toEqual([600]);
  });

  test("two adds of the same new email at once leave one account and one member", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await Promise.all([add([email("race")], "team"), add([email("race")], "team")]);
    expect(await db.user.count({ where: { email: email("race") } })).toBe(1);
    expect(await orgPeople(f.org.id, { emails: [email("race")] })).toHaveLength(1);
    expect(await peopleRulesBroken(f.org.id)).toEqual(NOTHING_BROKEN);
  });

  test("orgPeople lists members oldest first, hides disabled unless asked, and filters by role, email, user and member", async () => {
    await add([email("team")], "team");
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const all = await orgPeople(f.org.id, { includeDisabled: true });
    expect(all.map((p) => p.email)).toEqual([f.learner.email, f.trainer.email, email("team")]);
    expect(all[0]).toMatchObject({ memberId: `${f.learner.id}-member`, userId: f.learner.id, name: "Learner", role: "user", disabled: true, disabledAt: expect.any(Date), addedAt: expect.any(Date), image: null });
    expect((await orgPeople(f.org.id)).map((p) => p.email)).toEqual([f.trainer.email, email("team")]);
    expect((await orgPeople(f.org.id, { roles: ["team"] })).map((p) => p.email)).toEqual([email("team")]);
    expect((await orgPeople(f.org.id, { emails: [f.trainer.email.toUpperCase()] })).map((p) => p.userId)).toEqual([f.trainer.id]);
    expect((await orgPeople(f.org.id, { userIds: [f.trainer.id] })).map((p) => p.role)).toEqual(["admin"]);
    expect((await orgPeople(f.org.id, { memberIds: [`${f.learner.id}-member`], includeDisabled: true })).map((p) => p.userId)).toEqual([f.learner.id]);
    expect(await orgPeople("no-such-org")).toEqual([]);
    expect([...await studioPeopleEmails(f.org.id)].sort()).toEqual([email("team"), f.trainer.email].sort());
  });

  test("orgPerson finds one person by account, member or email (disabled included), only in this org", async () => {
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    for (const by of [{ userId: f.learner.id }, { memberId: `${f.learner.id}-member` }, { email: f.learner.email.toUpperCase() }]) {
      expect(await orgPerson(f.org.id, by)).toMatchObject({ userId: f.learner.id, disabled: true });
    }
    expect(await orgPerson("no-such-org", { userId: f.learner.id })).toBeNull();
    expect(await orgPerson(f.org.id, { email: "nobody@example.com" })).toBeNull();
  });
});
