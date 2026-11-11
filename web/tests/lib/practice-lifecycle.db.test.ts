import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as end from "@/lib/session-end";
import * as specs from "@/lib/specs";
import * as schedule from "@/lib/schedule-org-credits";
import { activateSession, finalizeInterviewSession } from "@/lib/interview-sessions";
import { sweepStaleCalls } from "@/lib/session-lifecycle";
import { learnerBalance, recordSessionUsage } from "@/lib/minutes";
import { orgCredits } from "@/lib/org-credits";
import { setMemberDisabled, changeMemberRole } from "@/lib/members";
import { assignTwinLearners } from "@/lib/invite/twin";
import { twinAccessByCode, updateTwinAssignment } from "@/lib/twin-access";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Real transactions/locks/ledger. Only chat, end-workflow dispatch and Meteroid reporting transport are faked.
describe.skipIf(!localMinutesDb)("Module 2 atomic start/end/assignment scenarios", () => {
  let f: MinutesFixture;
  let assignment: { id: string; shareCode: string };
  let secret: string | undefined;
  let ending: ReturnType<typeof spyOn<typeof end, "startSessionEnd">>;
  let fetching: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    secret = process.env.COPILOT_SERVICE_SECRET; process.env.COPILOT_SERVICE_SECRET = "practice-secret";
    assignment = await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, shareCode: `${f.org.id}-personal`, minutesLimit: 30 } });
    ending = spyOn(end, "startSessionEnd").mockResolvedValue(undefined);
    const fetch = globalThis.fetch;
    fetching = spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).includes("meteroid.test") ? fetch(url, init) : Promise.resolve(new Response(null, { status: 204 })));
    spies.push(ending, fetching, spyOn(schedule, "scheduleOrgUsage").mockResolvedValue(undefined));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET; else process.env.COPILOT_SERVICE_SECRET = secret;
    await f.clean();
  });
  const grant = (seconds = 600) => db.minuteLedger.create({ data: { orgId: f.org.id, email: f.learner.email, type: "grant", seconds } });
  const start = (studio = false) => activateSession({ orgId: f.org.id, userId: studio ? f.trainer.id : f.learner.id, ...(studio ? { agentSlug: f.twin.slug } : { shareCode: assignment.shareCode }), mode: "voice" });
  const live = () => db.interviewSession.count({ where: { orgId: f.org.id, status: { in: ["active", "activating"] } } });
  const oldCall = (extra: Parameters<MinutesFixture["session"]>[0] = {}) => f.session({ agentId: f.twin.id, agentSlug: f.twin.slug, twinAssignmentId: assignment.id, status: "active", startedAt: new Date(Date.now() - 90_000), endedAt: null, runtimeTokenHash: randomUUID(), ...extra });
  const assign = (emails = [f.learner.email]) => assignTwinLearners({ org: f.org, by: f.trainer, agent: f.twin, emails });
  const disable = () => setMemberDisabled({ orgId: f.org.id, memberId: `${f.learner.id}-member`, actorUserId: f.trainer.id, disabled: true });
  const restore = () => updateTwinAssignment({ orgId: f.org.id, agentId: f.twin.id, assignmentId: assignment.id, status: "active" });

  test("refuses credits_short without ending or charging the person's other live call", async () => {
    await grant(360); const old = await oldCall();
    await expect(start()).rejects.toMatchObject({ code: "credits_short", status: 403 });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await db.minuteLedger.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await live()).toBe(1); expect(ending).not.toHaveBeenCalled();
  });

  test("successful start charges the other live call exactly once and its end workflow observes the committed replacement", async () => {
    await grant(); const old = await oldCall();
    ending.mockImplementation(async (id) => {
      expect(id).toBe(old.id);
      // A separate db connection sees both rows and usage: dispatch cannot have run inside the start transaction.
      expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "abandoned", runtimeTokenHash: null });
      expect(await db.minuteLedger.count({ where: { sessionId: id } })).toBe(1);
      expect(await live()).toBe(1);
      expect(await db.interviewSession.count({ where: { orgId: f.org.id, status: "activating" } })).toBe(1);
    });
    const next = await start();
    const usage = await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: old.id } });
    expect(usage.seconds).toBeLessThanOrEqual(-90); expect(usage.seconds).toBeGreaterThan(-100);
    expect(next?.secondsLeft).toBe(600 + usage.seconds); expect(ending).toHaveBeenCalledTimes(1);
    expect(await live()).toBe(1);
  });

  test("refuses call_replaced when a parallel start ends a call still initializing; only one live call and no double spending", async () => {
    await grant();
    // Force both transactions to commit before either network setup returns; no sleeps or probabilistic race.
    let release!: () => void; const bothCommitted = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    fetching.mockImplementation(async () => { if (++arrivals === 2) release(); await bothCommitted; return new Response(null, { status: 204 }); });
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    if (!refused || refused.status !== "rejected") throw new Error("Expected one replaced call");
    expect(refused.reason).toMatchObject({ code: "call_replaced", status: 409, message: "This call was replaced by one you started elsewhere." });
    const replaced = await db.interviewSession.findFirstOrThrow({ where: { orgId: f.org.id, status: "abandoned" } });
    expect(replaced.runtimeTokenHash).toBeNull();
    // A metered call ended before initialization still has exactly one zero-second usage row.
    expect(replaced.startedAt).toBeNull();
    expect(await db.minuteLedger.findMany({ where: { sessionId: replaced.id }, select: { seconds: true } })).toEqual([{ seconds: 0 }]);
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBeGreaterThanOrEqual(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "usage" } })).toBeLessThanOrEqual(1);
    expect(await live()).toBe(1);
  });

  test("twin Start never resumes even with the same idempotency key", async () => {
    await grant();
    const input = { orgId: f.org.id, userId: f.learner.id, shareCode: assignment.shareCode, idempotencyKey: "same-tab", mode: "voice" as const };
    const first = await activateSession(input);
    const second = await activateSession(input);
    expect(await live()).toBe(1);
    expect(second!.id).not.toBe(first!.id);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: "abandoned", runtimeTokenHash: null });
    expect(await db.minuteLedger.count({ where: { sessionId: first!.id } })).toBe(1);
    expect(ending).toHaveBeenCalledWith(first!.id);
  });

  test("two studio members on a billed org reserve the first call's whole allowance", async () => {
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    await db.twinAssignment.delete({ where: { id: assignment.id } });
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const first = await start(true);
    expect(first?.secondsLeft).toBe(600); expect(await orgCredits(f.org.id)).toMatchObject({ seconds: 0 });
    await expect(activateSession({ orgId: f.org.id, userId: f.learner.id, agentSlug: f.twin.slug })).rejects.toMatchObject({ code: "org_credits_out", status: 403 });
    expect(await live()).toBe(1); expect(ending).not.toHaveBeenCalled();
  });

  test("studio's second preview of the same twin uses the normal charged end path after commit", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    const first = await start(true);
    await db.interviewSession.update({ where: { id: first!.id }, data: { startedAt: new Date(Date.now() - 90_000) } });
    ending.mockImplementation(async (id) => {
      expect(id).toBe(first!.id);
      expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "abandoned" });
      expect(await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: id } })).toMatchObject({ type: "org_usage", seconds: expect.any(Number) });
      expect(await live()).toBe(1);
    });
    const second = await start(true);
    expect(second!.id).not.toBe(first!.id); expect(second!.secondsLeft).toBeLessThanOrEqual(510);
    expect(ending).toHaveBeenCalledTimes(1); expect(await live()).toBe(1);
    expect(await db.minuteLedger.count({ where: { sessionId: first!.id } })).toBe(1);
  });

  test("refuses member_disabled after disable between the outer practice check and locked re-check, with no call/usage written", async () => {
    await grant();
    const compile = specs.getAgentConfigForAgent;
    spies.push(spyOn(specs, "getAgentConfigForAgent").mockImplementation(async (...args) => {
      await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
      return compile(...args);
    }));
    await expect(start()).rejects.toMatchObject({ code: "member_disabled", status: 403, message: "Your access to this organization has been turned off. Ask its admin to turn it back on." });
    expect(await live()).toBe(0); expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "usage" } })).toBe(0);
    expect(ending).not.toHaveBeenCalled(); expect(fetching).not.toHaveBeenCalled();
  });

  test("refuses voice_only for twin chat before ending or charging another call", async () => {
    await grant(); const old = await oldCall();
    await expect(activateSession({ orgId: f.org.id, userId: f.learner.id, shareCode: assignment.shareCode, mode: "chat" })).rejects.toMatchObject({ code: "voice_only", status: 400, message: "Twin calls are voice only." });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await db.minuteLedger.count({ where: { sessionId: old.id } })).toBe(0);
  });

  test("finalize twice writes one usage row in the end transaction and preserves its first end", async () => {
    const call = await oldCall({ allowedSeconds: 60 });
    await finalizeInterviewSession({ sessionId: call.id, requestedStatus: "completed" });
    const ended = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    await finalizeInterviewSession({ sessionId: call.id, requestedStatus: "completed" });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(ended);
    expect(await db.minuteLedger.findMany({ where: { sessionId: call.id }, select: { seconds: true } })).toEqual([{ seconds: -60 }]);
  });
  test.each(["failed", "revoked"])("%s calls produce no usage row, even after repeated retries", async (status) => {
    const call = await oldCall({ status, endedAt: new Date() });
    await Promise.all([recordSessionUsage(call.id), recordSessionUsage(call.id)]);
    expect(await db.minuteLedger.count({ where: { sessionId: call.id } })).toBe(0);
  });

  test.each(["failed", "revoked"])("ending an already %s call keeps the first end and costs zero", async (status) => {
    const call = await oldCall({ status, endedAt: new Date() });
    await finalizeInterviewSession({ sessionId: call.id, requestedStatus: "completed" });
    expect(await db.minuteLedger.count({ where: { sessionId: call.id } })).toBe(0);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status, endedAt: call.endedAt });
  });

  test("stale sweep abandons deadline+2min, free 3h and activating 10min calls, caps charges, clears tokens, leaves younger/ended calls", async () => {
    const expired = await oldCall({ allowedSeconds: 60, startedAt: new Date(Date.now() - 181_000) });
    const free = await oldCall({ userId: f.trainer.id, twinAssignmentId: null, allowedSeconds: null, startedAt: new Date(Date.now() - 10_801_000) });
    const stuck = await oldCall({ status: "activating", startedAt: null, createdAt: new Date(Date.now() - 601_000) });
    const keep = await Promise.all([
      oldCall({ allowedSeconds: 60, startedAt: new Date(Date.now() - 170_000) }),
      oldCall({ userId: f.trainer.id, twinAssignmentId: null, allowedSeconds: null, startedAt: new Date(Date.now() - 10_790_000) }),
      oldCall({ status: "activating", startedAt: null, createdAt: new Date(Date.now() - 590_000) }),
      oldCall({ status: "completed", endedAt: new Date() }),
    ]);
    const queryRaw = db.$queryRaw.bind(db);
    const select = spyOn(db, "$queryRaw").mockImplementation(async (query, ...values) => {
      const result = await queryRaw(query, ...values);
      const sql = typeof query === "object" && "strings" in query ? query.strings.join("") : "";
      if (sql.includes('SELECT "id" FROM "InterviewSession"')) {
        const own = new Set([expired.id, free.id, stuck.id, ...keep.map((call) => call.id)]);
        return (result as { id: string }[]).filter((call) => own.has(call.id));
      }
      return result;
    });
    try { expect(await sweepStaleCalls()).toBe(3); } finally { select.mockRestore(); }
    for (const call of [expired, free, stuck]) expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "abandoned", runtimeTokenHash: null, endedAt: expect.any(Date) });
    expect(await db.minuteLedger.findUniqueOrThrow({ where: { sessionId: expired.id } })).toMatchObject({ seconds: -60 });
    expect(await db.minuteLedger.count({ where: { sessionId: free.id } })).toBe(0);
    expect(await db.minuteLedger.findMany({ where: { sessionId: stuck.id }, select: { seconds: true } })).toEqual([{ seconds: 0 }]);
    for (const call of keep) expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(call);
    expect(ending.mock.calls.map(([id]) => id).filter((id) => [expired.id, free.id, stuck.id].includes(id))).toHaveLength(3);
  });

  test("assignment failure rolls back the batch's accounts, members and starting credits", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const emails = [`a-${f.org.id}@example.com`, `b-${f.org.id}@example.com`];
    // Real FK failure inside the assignment write, after people/grants would have been written.
    await expect(assignTwinLearners({ org: f.org, by: f.trainer, agent: { id: "missing-twin", name: "Gone" }, emails })).rejects.toThrow("TwinAssignment must point at a twin in the same organization");
    expect(await db.user.count({ where: { email: { in: emails } } })).toBe(0);
    expect(await db.member.count({ where: { organizationId: f.org.id } })).toBe(2);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await orgCredits(f.org.id)).toMatchObject({ seconds: 6000 });
  });

  test.each(["disable", "team"] as const)("assign and restore race with %s: no usable assignment survives", async (action) => {
    const change = () => action === "disable" ? disable() : changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    await db.twinAssignment.update({ where: { id: assignment.id }, data: { status: "revoked" } });
    const result = await Promise.allSettled([restore(), change()]);
    expect(result[1].status).toBe("fulfilled");
    if (result[0].status === "rejected") expect(result[0].reason).toMatchObject({ code: action === "disable" ? "person_disabled" : "person_is_studio", status: 409 });
    expect(await db.twinAssignment.count({ where: { agentId: f.twin.id, userId: f.learner.id, status: "active" } })).toBe(0);
    // Repeat assigning against the committed change, and then race from an enabled learner snapshot again.
    await expect(assign()).rejects.toMatchObject({ code: action === "disable" ? "person_disabled" : "person_is_studio", status: 409 });
    if (action === "disable") await setMemberDisabled({ orgId: f.org.id, memberId: `${f.learner.id}-member`, actorUserId: f.trainer.id, disabled: false });
    else await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "user" });
    const assigned = await Promise.allSettled([assign(), change()]);
    expect(assigned[1].status).toBe("fulfilled");
    if (assigned[0].status === "rejected") expect(assigned[0].reason).toMatchObject({ code: action === "disable" ? "person_disabled" : "person_is_studio" });
    expect(await db.twinAssignment.count({ where: { agentId: f.twin.id, userId: f.learner.id, status: "active" } })).toBe(0);
  });
  test.each(["person_disabled", "person_is_studio"] as const)("refuses person_disabled and refuses person_is_studio on restoring and assigning after the membership change: %s", async (code) => {
    const action = code === "person_disabled" ? "disable" : "team";
    await db.twinAssignment.update({ where: { id: assignment.id }, data: { status: "revoked" } });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: action === "disable" ? { disabledAt: new Date() } : { role: "team" } });
    const message = action === "disable" ? `${f.learner.email} is disabled in this organization. Re-enable them first.` : `${f.learner.email} is on the team. Team members practise with the organization's credits, not as learners.`;
    for (const operation of [restore, assign]) await expect(operation()).rejects.toMatchObject({ code, status: 409, message });
    expect(await db.twinAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: "revoked" });
  });

  test("common-link join in two tabs creates one member, assignment and starting grant", async () => {
    await db.twinAssignment.delete({ where: { id: assignment.id } });
    await db.member.delete({ where: { id: `${f.learner.id}-member` } });
    await fundOrg({ orgId: f.org.id, minutes: 60 });
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${f.org.id}-common`, minutesPerUser: 30, createdByUserId: f.trainer.id } });
    const join = () => twinAccessByCode({ orgId: f.org.id, user: f.learner, code: link.code, join: true });
    await expect(twinAccessByCode({ orgId: f.org.id, user: f.learner, code: link.code, join: false })).rejects.toMatchObject({ code: "no_org", status: 403 });
    const [a, b] = await Promise.all([join(), join()]); expect(a).toEqual(b);
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: f.learner.id } })).toBe(1);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id, userId: f.learner.id } })).toBe(1);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id }, select: { type: true, seconds: true } })).toEqual([{ type: "grant", seconds: 1800 }]);
    expect(await orgCredits(f.org.id)).toMatchObject({ seconds: 1800 });
  });
});
