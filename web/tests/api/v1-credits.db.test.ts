import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { auth } from "@/lib/auth";
import * as delivery from "@/lib/queue-emails";
import * as schedule from "@/lib/schedule-org-credits";
import { GET as orgCredits } from "@/app/api/v1/credits/route";
import { GET as learnerCredits, POST as giveCredits } from "@/app/api/v1/users/[id]/credits/route";
import { GET as users, POST as addUser } from "@/app/api/v1/users/route";
import { GET as scenarios } from "@/app/api/v1/scenarios/route";
import { GET as assignments, POST as assign } from "@/app/api/v1/assignments/route";
import { GET as sessions } from "@/app/api/v1/sessions/route";
import { GET as sessionDetail } from "@/app/api/v1/sessions/[id]/route";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("integration credits API (real keys, people, locks and ledger)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let key: string;
  let send: ReturnType<typeof spyOn<typeof delivery, "deliverEmail">>;
  let report: ReturnType<typeof spyOn<typeof schedule, "scheduleOrgUsage">>;
  const createKey = async (fixture: MinutesFixture, permissions?: Record<string, string[]>) => (await auth.api.createApiKey({ body: {
    name: "Integration test", organizationId: fixture.org.id, userId: fixture.trainer.id,
    metadata: { createdByUserId: fixture.trainer.id }, ...(permissions ? { permissions } : {}),
  } })).key;
  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture(); await f.create(); await other.create();
    key = await createKey(f);
    send = spyOn(delivery, "deliverEmail").mockResolvedValue({ sent: true });
    report = spyOn(schedule, "scheduleOrgUsage").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    send.mockRestore(); report.mockRestore();
    await db.apikey.deleteMany({ where: { referenceId: { in: [f.org.id, other.org.id] } } });
    await other.clean(); await f.clean();
  });
  const request = (path: string, method = "GET", body?: unknown, idempotencyKey?: string, token = key) => new Request(`https://test/api/v1/${path}`, {
    method, headers: { "content-type": "application/json", "x-api-key": token, ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const params = (id = f.learner.id) => ({ params: Promise.resolve({ id }) });
  const grant = (minutes: number, requestKey = "grant-1", userId = f.learner.id, note?: string) => giveCredits(request(`users/${userId}/credits`, "POST", { minutes, ...(note === undefined ? {} : { note }) }, requestKey), params(userId));

  test("catalog -> add learner -> credits -> assign -> sessions/transcript/report uses only the public API", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 120 });
    const catalog = await (await scenarios(request("scenarios"))).json();
    expect(catalog.scenarios.map((item: { slug: string }) => item.slug)).toEqual([f.roleplay.slug]);
    const address = `integration-${f.org.id}@example.com`;
    const added = await addUser(request("users", "POST", { email: address }));
    expect(added.status).toBe(201);
    const { user } = await added.json();
    expect(user).toMatchObject({ email: address, role: "member", creditsGiven: 30, creditsLeft: 30 });
    expect(await (await users(request(`users?email=${encodeURIComponent(address.toUpperCase())}`))).json()).toMatchObject({ users: [{ id: user.id }], pagination: { total: 1 } });
    expect(await (await orgCredits(request("credits"))).json()).toEqual({ balanceMinutes: 90, defaultLearnerMinutes: 30, maxLearnerMinutes: 360 });
    expect(await (await learnerCredits(request(`users/${user.id}/credits`), params(user.id))).json()).toEqual({ userId: user.id, givenMinutes: 30, usedMinutes: 0, balanceMinutes: 30, maxLearnerMinutes: 360 });
    const given = await grant(15, "extra", user.id, "Extra practice");
    expect(given.status).toBe(201);
    const receipt = await given.json();
    expect(receipt).toMatchObject({ created: true, balanceMinutes: 45, orgBalanceMinutes: 75, emailSent: true, grant: { userId: user.id, minutes: 15, note: "Extra practice" } });
    const replay = await grant(15, "extra", user.id, "Extra practice");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ grant: receipt.grant, created: false, emailSent: false });
    expect(send).toHaveBeenCalledTimes(2); // Added and credited, never the replay.
    const assigned = await assign(request("assignments", "POST", { userId: user.id, scenario: f.roleplay.slug }));
    expect(assigned.status).toBe(201);
    const link = await assigned.json();
    expect(link.practiceUrl).toContain("/s/");
    expect(await (await assignments(request(`assignments?userId=${user.id}`))).json()).toMatchObject({ pagination: { total: 1 }, assignments: [{ id: link.assignment.id }] });
    const call = await f.session({ userId: user.id, assignmentId: link.assignment.id, report: { kind: "roleplay", summary: "Practice completed" }, reportStatus: "completed", transcript: [{ role: "user", text: "My answer" }] });
    expect(await (await sessions(request(`sessions?userId=${user.id}&scenario=${f.roleplay.slug}`))).json()).toMatchObject({ pagination: { total: 1 }, sessions: [{ id: call.id, chargesOrg: false }] });
    const detail = await (await sessionDetail(request(`sessions/${call.id}`), params(call.id))).json();
    expect(detail.session).toMatchObject({ transcript: call.transcript, report: call.report, reportStatus: "completed", audioUrl: null, videoUrl: null });
    expect(detail.session).not.toHaveProperty("runtimeTokenHash");
    expect(await (await learnerCredits(request(`users/${user.id}/credits`), params(user.id))).json()).toMatchObject({ givenMinutes: 45, usedMinutes: 1.5, balanceMinutes: 43.5 });
  });

  test("session reads include stored reports and disabled learners' history, but hide deleted/foreign/twin calls", async () => {
    const completed = await f.session({ report: { summary: "Stored result" }, reportStatus: "completed" });
    const closing = await f.session({ status: "closing", endedAt: null });
    const deleted = await f.session({ deletedAt: new Date() });
    const twin = await f.session({ userId: f.trainer.id, agentId: f.twin.id, agentSlug: f.twin.slug });
    const foreign = await other.session();
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const listed = await (await sessions(request("sessions"))).json();
    expect(listed.sessions.map((session: { id: string }) => session.id).sort()).toEqual([completed.id, closing.id].sort());
    expect(await (await sessionDetail(request(`sessions/${completed.id}`), params(completed.id))).json()).toMatchObject({ session: { report: completed.report, reportStatus: "completed" } });
    expect(await (await sessions(request("sessions?status=closing"))).json()).toMatchObject({ pagination: { total: 1 }, sessions: [{ id: closing.id }] });
    for (const id of [deleted.id, twin.id, foreign.id]) expect((await sessionDetail(request(`sessions/${id}`), params(id))).status).toBe(404);
    for (const filter of ["from=2026-12-01T00:00:00Z&to=2026-01-01T00:00:00Z", "from=", "status="]) {
      const response = await sessions(request(`sessions?${filter}`));
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_input" });
    }
  });

  test("parallel retries create one ledger grant and one notification, even after later spending or pause", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const responses = await Promise.all(Array.from({ length: 8 }, () => grant(20)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(bodies.map((body) => body.grant.id)).size).toBe(1);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, requestKey: "grant-1" } })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: `paid-${f.org.id}`, pausedAt: new Date() } });
    expect((await grant(20)).status).toBe(200);
    expect((await grant(1, "new-grant")).status).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalled(); // A replay may repair an unsent Meteroid usage event.
  });

  test.each(["amount", "note", "learner"])("refuses idempotency_conflict when the %s changes", async (change) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    expect((await grant(10, "same", f.learner.id, "First")).status).toBe(201);
    const added = await (await addUser(request("users", "POST", { email: `second-${f.org.id}@example.com` }))).json();
    const result = await grant(change === "amount" ? 11 : 10, "same", change === "learner" ? added.user.id : f.learner.id, change === "note" ? "Other" : "First");
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ code: "idempotency_conflict", error: "This Idempotency-Key was already used for a different credit grant." });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, requestKey: "same" } })).toBe(1);
  });

  test("a request key is shared across keys of one org but independent across orgs", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 }); await fundOrg({ orgId: other.org.id, minutes: 30 });
    expect((await grant(10, "same")).status).toBe(201);
    key = await createKey(f);
    expect((await grant(10, "same")).status).toBe(200);
    const otherKey = await createKey(other);
    expect((await giveCredits(request(`users/${other.learner.id}/credits`, "POST", { minutes: 10 }, "same", otherKey), params(other.learner.id))).status).toBe(201);
  });

  test("different concurrent grants cannot overdraw the shared org balance", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const responses = await Promise.all([grant(80, "a"), grant(80, "b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect(await (await orgCredits(request("credits"))).json()).toMatchObject({ balanceMinutes: 20 });
  });

  test.each(["disabled", "team", "foreign", "unknown"])("refuses a %s recipient with no grant", async (kind) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    if (kind === "disabled") await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    if (kind === "team") await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    const id = kind === "foreign" ? other.learner.id : kind === "unknown" ? "unknown" : f.learner.id;
    expect((await learnerCredits(request(`users/${id}/credits`), params(id))).status).toBe(404);
    const response = await grant(10, "refused", id);
    expect(response.status).toBe(["disabled", "team"].includes(kind) ? 409 : 404);
    expect(await response.json()).toMatchObject({ code: kind === "disabled" ? "person_disabled" : kind === "team" ? "person_is_studio" : "not_found" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  test.each([undefined, "", "has space", "x".repeat(129)])("requires a valid Idempotency-Key (%s)", async (header) => {
    const response = await giveCredits(request("users/id/credits", "POST", { minutes: 10 }, header), params());
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_input" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test.each([0, -1, 1.5, 361, "10"])("refuses invalid_input for minutes %s", async (minutes) => {
    const response = await giveCredits(request("users/id/credits", "POST", { minutes }, "invalid"), params());
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_input" });
  });

  test("existing users scopes authorize credits; read-only keys cannot grant", async () => {
    const readOnly = await createKey(f, { users: ["read"] });
    expect((await orgCredits(request("credits", "GET", undefined, undefined, readOnly))).status).toBe(200);
    const refused = await giveCredits(request("users/id/credits", "POST", { minutes: 10 }, "scope", readOnly), params());
    expect(refused.status).toBe(403); expect(await refused.json()).toMatchObject({ code: "scope_missing" });
    expect((await orgCredits(request("credits", "GET", undefined, undefined, "bad-key"))).status).toBe(401);
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { disabledAt: new Date() } });
    expect((await orgCredits(request("credits"))).status).toBe(403);
  });

  test("active trainer reservations remain unavailable for grants", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await f.session({ userId: f.trainer.id, chargesOrg: true, allowedSeconds: 1800, status: "active", endedAt: null, startedAt: new Date() });
    expect(await (await orgCredits(request("credits"))).json()).toMatchObject({ balanceMinutes: 70 });
    expect((await grant(60, "fits")).status).toBe(201);
    expect((await grant(20, "too-much")).status).toBe(409);
    expect(await (await orgCredits(request("credits"))).json()).toMatchObject({ balanceMinutes: 10 });
  });

  test("refuses minutes beyond the learner cap; notification failures do not create duplicate grants", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 500 });
    send.mockRejectedValueOnce(new Error("Notification unavailable"));
    const response = await grant(360, "cap");
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ emailSent: false, balanceMinutes: 360 });
    expect((await grant(360, "cap")).status).toBe(200);
    expect((await grant(1, "over-cap")).status).toBe(400);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
