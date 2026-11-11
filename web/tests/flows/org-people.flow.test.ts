import "./flow-env";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as externalApi from "@/lib/external-api";
import { POST as addUser } from "@/app/api/v1/users/route";
import { POST as assign } from "@/app/api/v1/assignments/route";
import { PATCH as moveAssignment } from "@/app/api/v1/assignments/[id]/route";
import { minutesRouter } from "@/lib/minutes-trpc";
import { twinRouter } from "@/lib/twin/trpc";
import { runRoleplayAssign } from "@/lib/workflow-runs";
import { orgPeople, orgPerson } from "@/lib/org-people";
import { listUsers } from "@/lib/learners";
import { activateSession } from "@/lib/interview-sessions";
import { createTwinShareLink, listTwinAssignments, twinAccessByCode } from "@/lib/twin-access";
import { checkOrgPeople } from "@/scripts/check-org-people";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";
import { outsideServices } from "./harness";

// Real entry points and DB; Resend/Meteroid/LiveKit/chat are intercepted at the network, not replaced app logic.
describe.skipIf(!localMinutesDb)("flow: people first at every entry point", () => {
  let f: MinutesFixture;
  const outside = outsideServices();
  let key: ReturnType<typeof spyOn<typeof externalApi, "requireExternalApi">>;
  const email = (name: string) => `${name}-${f.org.id}@example.com`;
  const ctx = () => ({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const api = () => minutesRouter.createCaller(ctx());
  const request = (method: string, body: unknown) => new Request("https://dash.test/api/v1/assignments", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const assigned = (body: unknown) => assign(request("POST", body));
  const invariant = async () => {
    // Other parallel flows may still be adding members; check the postcondition after their writes settle.
    let checks = await checkOrgPeople();
    for (let attempt = 0; attempt < 40 && checks.some((check) => Boolean(check.broken)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      checks = await checkOrgPeople();
    }
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((check) => Boolean(check.broken))).toEqual([]);
    expect(outside.unexpected).toEqual([]);
  };
  beforeEach(async () => {
    f = minutesFixture(); outside.start(); outside.reset(); await f.create();
    await fundOrg({ orgId: f.org.id, minutes: 300 });
    key = spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, trainer: { memberId: `${f.trainer.id}-member`, userId: f.trainer.id, ...f.trainer, image: null, role: "admin", disabled: false, disabledAt: null, addedAt: new Date() }, actorUserId: f.trainer.id, keyId: "test-key" });
  });
  afterEach(async () => { key?.mockRestore(); await f.clean(); outside.stop(); });

  test.each(["team", "user"] as const)("Settings addPeople %s: immediate member, one combined email, no invitation", async (role) => {
    const to = email(role);
    expect(await api().addPeople({ emails: [to.toUpperCase(), to], role, minutes: role === "user" ? 40 : undefined })).toMatchObject({ added: 1, already: 0 });
    expect(await orgPerson(f.org.id, { email: to })).toMatchObject({ role, disabled: false });
    expect(outside.emails).toHaveLength(1);
    expect(outside.emails[0].to).toEqual([to]);
    expect(outside.emails[0].text).toContain("added you");
    if (role === "user") expect(outside.emails[0].text).toContain("40 credits added");
    else expect(outside.emails[0].text).toContain("a team member");
    expect(await api().addPeople({ emails: [to], role })).toMatchObject({ added: 0, already: 1 });
    expect(outside.emails).toHaveLength(1);
    await invariant();
  });

  test("twin assign to a new email: same account on Settings, Users and Twin users; one added+twin+credits email", async () => {
    const to = email("twin");
    const twin = twinRouter.createCaller(ctx());
    expect(await twin.assignments.assign({ slug: f.twin.slug, emails: [to] })).toMatchObject({ added: 1, joined: 1 });
    const person = (await orgPerson(f.org.id, { email: to }))!;
    expect((await orgPeople(f.org.id)).find((p) => p.email === to)?.userId).toBe(person.userId);
    expect((await listUsers(f.org.id)).find((p) => p.email === to)?.userId).toBe(person.userId);
    expect((await listTwinAssignments(f.org.id, f.twin.id)).find((p) => p.email === to)?.user.id).toBe(person.userId);
    expect(outside.emails).toHaveLength(1);
    expect(outside.emails[0].text).toContain("added you");
    expect(outside.emails[0].text).toContain("You can now talk to Twin");
    expect(outside.emails[0].text).toContain("30 credits added");
    await invariant();
  });

  test("role-play assign to a new email: member first, assignment on member, one combined email", async () => {
    const to = email("roleplay");
    expect(await runRoleplayAssign({ org: f.org, by: f.trainer, agent: f.roleplay, emails: [to] })).toMatchObject({ added: 1, joined: 1 });
    const person = (await orgPerson(f.org.id, { email: to }))!;
    expect(await db.rolePlayAssignment.findFirstOrThrow({ where: { orgId: f.org.id } })).toMatchObject({ memberId: person.memberId });
    expect(outside.emails).toHaveLength(1);
    expect(outside.emails[0].text).toContain("added you");
    expect(outside.emails[0].text).toContain("30 credits added");
    await invariant();
  });

  test("REST POST /users: 201, then 200 unchanged; 409 studio/disabled; no duplicate email", async () => {
    const to = email("rest");
    const post = (email: string) => addUser(request("POST", { email }));
    const first = await post(to); expect(first.status).toBe(201);
    const body = await first.json(); expect(body).toMatchObject({ created: true, emailSent: true, user: { email: to, role: "member" } });
    const again = await post(to.toUpperCase()); expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, user: { id: body.user.id, memberId: body.user.memberId } });
    expect((await post(f.trainer.email)).status).toBe(409);
    await db.member.update({ where: { id: body.user.memberId }, data: { disabledAt: new Date() } });
    const disabled = await post(to); expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: expect.stringContaining("Re-enable") });
    expect(outside.emails).toHaveLength(1);
    await invariant();
  });

  test.each(["email", "userId"] as const)("REST POST /assignments by %s: member-bound and idempotent, one email", async (by) => {
    const target = by === "email" ? { email: email("api-assigned") } : { userId: f.learner.id };
    const first = await assigned({ ...target, scenario: f.roleplay.slug }); expect(first.status).toBe(201);
    const body = await first.json(); expect(body).toMatchObject({ created: true, emailSent: true });
    const member = await orgPerson(f.org.id, { userId: body.assignment.userId });
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: body.assignment.id } })).toMatchObject({ memberId: member!.memberId });
    expect((await assigned({ ...target, scenario: f.roleplay.slug })).status).toBe(200);
    expect(outside.emails).toHaveLength(1);
    await invariant();
  });

  test("REST PATCH to a new email: add member, replace account and link, email new person once", async () => {
    const first = await (await assigned({ email: f.learner.email, scenario: f.roleplay.slug })).json();
    const to = email("moved");
    const response = await moveAssignment(request("PATCH", { email: to }), { params: Promise.resolve({ id: first.assignment.id }) });
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body).toMatchObject({ changed: true, emailSent: true, assignment: { email: to } });
    expect(body.practiceUrl).not.toBe(first.practiceUrl);
    const person = (await orgPerson(f.org.id, { email: to }))!;
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: first.assignment.id } })).toMatchObject({ memberId: person.memberId });
    expect(outside.emails.map((e) => e.to)).toEqual([[f.learner.email], [to]]);
    await invariant();
  });

  test("shared twin join: adds member immediately, but admin/team openers get no assignment and no email", async () => {
    const outsider = await db.user.create({ data: { id: `${f.org.id}-outside`, name: "Outside", email: email("outside"), emailVerified: true } });
    const link = await createTwinShareLink({ orgId: f.org.id, agentId: f.twin.id, minutesPerUser: 30, createdByUserId: f.trainer.id });
    expect(await orgPerson(f.org.id, { userId: outsider.id })).toBeNull();
    const access = await twinAccessByCode({ orgId: f.org.id, user: outsider, code: link.code, join: true });
    expect(await orgPerson(f.org.id, { userId: outsider.id })).toMatchObject({ role: "user" });
    expect(await db.twinAssignment.findUniqueOrThrow({ where: { id: access!.assignmentId! } })).toMatchObject({ userId: outsider.id });
    for (const role of ["admin", "team"]) {
      await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
      expect(await twinAccessByCode({ orgId: f.org.id, user: f.trainer, code: link.code, join: true })).toEqual({ agentId: f.twin.id, assignmentId: null });
    }
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role: "admin" } });
    expect(await db.twinAssignment.count({ where: { userId: f.trainer.id } })).toBe(0);
    expect(outside.emails).toEqual([]);
    await invariant();
  });

  test("session start refuses a non-member with 403 and creates neither member nor session", async () => {
    const outsider = await db.user.create({ data: { id: `${f.org.id}-outside`, email: email("outside"), name: "Outside", emailVerified: true } });
    await expect(activateSession({ orgId: f.org.id, userId: outsider.id, userEmail: outsider.email, agentSlug: f.roleplay.slug, mode: "voice" }))
      .rejects.toMatchObject({ status: 403 });
    expect(await orgPerson(f.org.id, { userId: outsider.id })).toBeNull();
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(outside.chatSessions).toEqual([]);
    await invariant();
  });

  test("regression: give credits fallback preserves the event idempotency key; skips nonmembers, studio and disabled with reasons; normalized duplicates email each learner once", async () => {
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const to = email("credits"); await api().addPeople({ emails: [to], role: "user" }); outside.reset();
    const result = await api().addMany({ emails: [to, to.toUpperCase(), email("unknown"), f.trainer.email, f.learner.email], minutes: 10 });
    expect(result).toMatchObject({ given: [to], skipped: [
      { email: email("unknown"), reason: "is not in this organization" },
      { email: f.trainer.email, reason: expect.stringContaining("studio team") },
      { email: f.learner.email, reason: "is disabled" },
    ] });
    expect(outside.emails).toHaveLength(1);
    expect(outside.emails[0].to).toEqual([to]);
    expect(outside.emails[0].text).toContain("10 credits added. Your balance: 40 credits");
    try {
      expect(outside.emails[0].idempotencyKey).toMatch(new RegExp(`^credits:${f.org.id}:${to}:\\d+$`));
    } finally {
      await invariant();
    }
  });
});
