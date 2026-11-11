import { availableOrgSeconds, fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextHeaders from "next/headers";
import * as sessionUser from "@/lib/session-user";
import { ensureDeployment } from "@/lib/deployments";
import { changeMemberRole } from "@/lib/members";
import { listUsers } from "@/lib/learners";
import { loadSharedSession, loadTwinLink } from "@/lib/pages/learner";
import { loadOrgHome } from "@/lib/pages/org-home";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { ROLEPLAY_SOURCE } from "@/lib/scenario-ingest";
import { grantMinutes, recordSessionUsage } from "@/lib/minutes";
import { activateSession } from "@/lib/interview-sessions";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("learner pages with minutes (local database)", () => {
  let f: MinutesFixture;
  let headers: ReturnType<typeof spyOn<typeof nextHeaders, "headers">>;
  let identity: ReturnType<typeof spyOn<typeof sessionUser, "resolveSessionUser">>;
  let code: string;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    headers = spyOn(nextHeaders, "headers").mockResolvedValue(new Headers({ host: `${f.org.slug}.example.com` }));
    identity = spyOn(sessionUser, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    const deployment = await ensureDeployment(f.org.id, f.roleplay.id);
    code = `${f.org.id}-invite`;
    await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, assignedByUserId: f.trainer.id, shareCode: code, expiresAt: new Date(Date.now() + 3600_000) } });
  });
  afterEach(async () => { headers?.mockRestore(); identity?.mockRestore(); await f.clean(); });
  const balance = async (seconds: number) => {
    await fundOrg({ orgId: f.org.id, minutes: 10, note: "test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 10 });
    const session = await f.session({ allowedSeconds: 600, endedAt: new Date(new Date("2026-01-01T00:00:00Z").getTime() + (600 - seconds) * 1000) });
    await recordSessionUsage(session.id);
  };

  test.each([
    { status: "pending", pastStatus: "completed" },
    { status: "used", pastStatus: "completed" },
    { status: "used", pastStatus: "abandoned" },
    { status: "used", pastStatus: "failed" },
  ])("loadSharedSession opens a past-date $status link after a $pastStatus session", async ({ status, pastStatus }) => {
    await balance(600);
    const assignment = await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { status, expiresAt: new Date(0) } });
    await f.session({ assignmentId: assignment.id, status: pastStatus, startedAt: new Date(0), endedAt: new Date(0) });
    expect(await loadSharedSession(code)).toMatchObject({ kind: "session", props: { sessionCode: code, minutesLeft: 10 } });
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status, expiresAt: new Date(0) });
  });

  test.each(["cancelled", "expired"])("loadSharedSession rejects %s status despite available minutes", async (status) => {
    await balance(600);
    await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { status } });
    expect(await loadSharedSession(code)).toEqual({ kind: "invalid" });
  });

  test("loadSharedSession asks the wrong account to switch on a used, past-date link", async () => {
    await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { status: "used", expiresAt: new Date(0) } });
    identity.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.trainer, signInUrl: "/sign-in" });
    expect(await loadSharedSession(code)).toMatchObject({ kind: "switchAccount", email: f.trainer.email });
  });

  test("loadSharedSession rejects a link outside the current org", async () => {
    identity.mockResolvedValue({ org: { ...f.org, id: `${f.org.id}-other`, accentColor: null }, user: f.learner, signInUrl: "/sign-in" });
    expect(await loadSharedSession(code)).toEqual({ kind: "invalid" });
  });

  test("a practised, past-date link still shows outOfMinutes when its minutes run out", async () => {
    await balance(0);
    const assignment = await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { status: "used", expiresAt: new Date(0) } });
    await f.session({ assignmentId: assignment.id, startedAt: new Date(0), endedAt: new Date(0) });
    expect(await loadSharedSession(code)).toEqual({ kind: "outOfMinutes", email: f.learner.email, minutesLeft: 0 });
  });

  test("loadOrgHome lists the learner's own pending and used role play regardless of practice history or expiry date", async () => {
    const original = await db.rolePlayAssignment.findUniqueOrThrow({ where: { shareCode: code } });
    // Someone else's learner assignment never shows; studio members cannot hold learner assignments.
    const other = await db.user.create({ data: { id: `${f.org.id}-other`, email: `other-${f.org.id}@example.com`, name: "Other learner", emailVerified: true } });
    const member = await db.member.create({ data: { id: `${other.id}-member`, organizationId: f.org.id, userId: other.id, role: "user", createdAt: new Date() } });
    await db.rolePlayAssignment.create({ data: {
      orgId: f.org.id, deploymentId: original.deploymentId, memberId: member.id,
      assignedByUserId: f.trainer.id, status: "pending", shareCode: `${code}-someone-else`, expiresAt: new Date(0),
    } });
    await f.session({ assignmentId: original.id });
    for (const status of ["pending", "used", "cancelled", "expired"]) {
      for (const past of [true, false]) {
        await db.rolePlayAssignment.update({ where: { id: original.id }, data: { status, expiresAt: past ? new Date(0) : new Date(Date.now() + 3600_000) } });
        const home = await loadOrgHome();
        if (home.kind !== "home") throw new Error("Expected org home");
        expect(home.props.roleplays.map((roleplay) => roleplay.href)).toEqual(status === "pending" || status === "used" ? [`/s/${code}`] : []);
      }
    }
  });

  test("roleplay scenarios.get keeps an old pending member pending rather than deriving expired", async () => {
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { source: ROLEPLAY_SOURCE } } });
    const assignment = await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { expiresAt: new Date(0) } });
    const caller = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
    const scenario = await caller.scenarios.get({ slug: f.roleplay.slug });
    expect(scenario.members).toMatchObject([{ id: assignment.id, status: "pending" }]);
    expect((await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe("pending");
  });

  test.each([0, 59, 60, 119, 120, 180, 299])("shared session shows outOfMinutes with %s seconds left", async (seconds) => {
    await balance(seconds);
    expect(await loadSharedSession(code)).toEqual({ kind: "outOfMinutes", email: f.learner.email, minutesLeft: Math.max(0, Math.floor(seconds / 60)) });
  });

  test.each([300, 359, 600])("shared session passes floored minutesLeft with %s seconds left", async (seconds) => {
    await balance(seconds);
    expect(await loadSharedSession(code)).toMatchObject({ kind: "session", props: { minutesLeft: Math.floor(seconds / 60) } });
  });

  test.each(["admin", "team"])("studio %s sees no metering on common shared sessions or twin preview, without learner assignments", async (role) => {
    await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${code}-studio`, minutesPerUser: 30 } });
    if (role === "admin") await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role: "team" } });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role } });
    expect(await loadSharedSession(link.code)).toMatchObject({ kind: "session", props: { minutesLeft: null } });
    const view = await loadTwinLink("twin");
    expect(view).toMatchObject({ kind: "flow", props: { access: { ok: true, preview: true } } });
    if (view.kind === "flow") expect(view.props.access).not.toHaveProperty("minutesLeft");
  });

  test("assigned twin shows used below a minute, blocked below five, then passes minutesLeft and minutesTotal", async () => {
    await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, minutesLimit: 999, shareCode: `${code}-twin` } });
    expect(await loadTwinLink("twin")).toMatchObject({ kind: "flow", props: { access: { ok: false, reason: "used" } } });
    await balance(119);
    expect(await loadTwinLink("twin")).toMatchObject({ kind: "flow", props: { access: { ok: false, reason: "blocked", message: "You need at least 5 minutes to start a call; you have 1. Ask your trainer for more." } } });
    await db.minuteLedger.deleteMany({ where: { orgId: f.org.id } });
    await db.interviewSession.deleteMany({ where: { orgId: f.org.id } });
    await balance(300);
    expect(await loadTwinLink("twin")).toMatchObject({ kind: "flow", props: { access: { ok: true, preview: false, minutesLeft: 5, minutesTotal: 10 } } });
  });

  test("Users page shares the same floored learner balance across modules", async () => {
    await balance(119);
    const rows = await listUsers(f.org.id);
    expect(rows.find((r) => r.email === f.learner.email)).toMatchObject({ minutesLeft: 1, roleplaySessions: 1, twinSessions: 0 });
    expect(rows.find((r) => r.email === f.trainer.email)).toBeUndefined();
  });

  test("listUsers leaves out someone moved to the studio team (one member row per account: their role decides)", async () => {
    await balance(119);
    await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    expect((await listUsers(f.org.id)).find((row) => row.email === f.learner.email)).toBeUndefined();
  });

  test.each([299, 300])("assigned twin shared link enforces the five-minute boundary (%s seconds)", async (seconds) => {
    const shareCode = `${code}-twin`;
    await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, minutesLimit: 30, shareCode } });
    await balance(seconds);
    expect(await loadSharedSession(shareCode)).toMatchObject(seconds < 300
      ? { kind: "outOfMinutes", minutesLeft: 4, email: f.learner.email }
      : { kind: "session", props: { minutesLeft: 5 } });
  });

  const commonVisitor = async () => {
    const user = await db.user.create({ data: { id: `${f.org.id}-visitor`, name: "Visitor", email: `visitor-${f.org.id}@example.com`, emailVerified: true } });
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${code}-common`, minutesPerUser: 30, createdByUserId: f.trainer.id } });
    identity.mockResolvedValue({ org: { ...f.org, accentColor: null }, user, signInUrl: "/sign-in" });
    return { user, link };
  };
  const commonState = () => Promise.all([
    db.member.findMany({ where: { organizationId: f.org.id }, orderBy: { id: "asc" } }),
    db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } }),
    db.twinAssignment.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } }),
    db.interviewSession.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } }),
  ]);

  test("opening a common link page adds an existing account with starting credits and an assignment only once", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 60 });
    const { user, link } = await commonVisitor();
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: user.id } })).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);

    const first = await loadSharedSession(link.code);
    expect(first).toMatchObject({ kind: "session", props: { sessionCode: link.code, minutesLeft: 30 } });
    expect(await db.member.findMany({ where: { organizationId: f.org.id, userId: user.id } })).toMatchObject([{ role: "user", disabledAt: null }]);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id } })).toMatchObject([{ email: user.email, type: "grant", seconds: 1800 }]);
    expect(await db.twinAssignment.findMany({ where: { orgId: f.org.id } })).toMatchObject([{ userId: user.id, agentId: f.twin.id, shareLinkId: link.id, status: "active" }]);
    expect(await availableOrgSeconds(f.org.id)).toBe(1800);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(user);

    const joined = await commonState();
    expect(await loadSharedSession(link.code)).toEqual(first);
    expect(await commonState()).toEqual(joined);
    expect(await availableOrgSeconds(f.org.id)).toBe(1800);
  });

  test.each([
    { name: "a disabled member without an assignment opening a common link shows unavailable and adds nothing", assigned: false },
    { name: "a disabled member with a leftover active assignment sees unavailable when opening a common link", assigned: true },
  ])("$name", async ({ assigned }) => {
    await fundOrg({ orgId: f.org.id, minutes: 60 });
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${code}-common`, minutesPerUser: 30 } });
    if (assigned) {
      await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 30 });
      await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, status: "active", minutesLimit: 30, shareCode: `${code}-personal`, shareLinkId: link.id } });
    }
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const before = await commonState();
    const credits = await availableOrgSeconds(f.org.id);
    expect(await loadSharedSession(link.code)).toEqual({ kind: "twinUnavailable", email: f.learner.email, message: "Your access to this organization has been turned off. Ask its admin to turn it back on." });
    expect(await commonState()).toEqual(before);
    expect(await availableOrgSeconds(f.org.id)).toBe(credits);
  });

  test.each([0, 29])("opening a common link with %s org credits shows unavailable and adds nothing", async (minutes) => {
    await fundOrg({ orgId: f.org.id, minutes });
    const { user, link } = await commonVisitor();
    const before = await commonState();
    expect(await loadSharedSession(link.code)).toMatchObject({ kind: "twinUnavailable", email: user.email, message: expect.stringContaining("Not enough credits") });
    expect(await commonState()).toEqual(before);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(user);
    expect(await availableOrgSeconds(f.org.id)).toBe(minutes * 60);
  });

  test("a member who joined through the common link page can start without another grant or assignment", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 60 });
    const { user, link } = await commonVisitor();
    expect(await loadSharedSession(link.code)).toMatchObject({ kind: "session", props: { minutesLeft: 30 } });
    const before = await commonState();
    const assignment = await db.twinAssignment.findFirstOrThrow({ where: { orgId: f.org.id, userId: user.id } });
    const secret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = "minutes-test-secret";
    const networkFetch = globalThis.fetch;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url).includes("meteroid.test") ? networkFetch(url, init) : Promise.resolve(new Response(null, { status: 204 })));
    try {
      const started = await activateSession({ orgId: f.org.id, userId: user.id, userEmail: user.email, shareCode: link.code, mode: "voice" });
      expect(started).toMatchObject({ status: "active", mode: "voice", secondsLeft: 1800 });
      expect(await db.interviewSession.findMany({ where: { orgId: f.org.id } })).toMatchObject([{ id: started!.id, userId: user.id, twinAssignmentId: assignment.id, allowedSeconds: 1800 }]);
      expect((await commonState()).slice(0, 3)).toEqual(before.slice(0, 3));
      expect(await availableOrgSeconds(f.org.id)).toBe(1800);
    } finally {
      fetchMock.mockRestore();
      if (secret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
      else process.env.COPILOT_SERVICE_SECRET = secret;
    }
  });
});
