import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nextHeaders from "next/headers";
import * as sessionUser from "@/lib/session-user";
import { ensureDeployment } from "@/lib/deployments";
import { listUsers } from "@/lib/learners";
import { loadSharedSession, loadTwinLink } from "@/lib/pages/learner";
import { loadOrgHome } from "@/lib/pages/org-home";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { ROLEPLAY_SOURCE } from "@/lib/scenario-ingest";
import { grantMinutes, recordSessionUsage, topUpOrg } from "@/lib/minutes";
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
    await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, recipientEmail: f.learner.email, assignedByUserId: f.trainer.id, shareCode: code, expiresAt: new Date(Date.now() + 3600_000) } });
  });
  afterEach(async () => { headers?.mockRestore(); identity?.mockRestore(); await f.clean(); });
  const balance = async (seconds: number) => {
    await topUpOrg({ orgId: f.org.id, minutes: 2, note: "test" });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 2 });
    const session = await f.session({ allowedSeconds: 120, endedAt: new Date(new Date("2026-01-01T00:00:00Z").getTime() + (120 - seconds) * 1000) });
    await recordSessionUsage(session.id);
  };

  test.each([
    { status: "pending", pastStatus: "completed" },
    { status: "used", pastStatus: "completed" },
    { status: "used", pastStatus: "abandoned" },
    { status: "used", pastStatus: "failed" },
  ])("loadSharedSession opens a past-date $status link after a $pastStatus session", async ({ status, pastStatus }) => {
    await balance(120);
    const assignment = await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { status, expiresAt: new Date(0) } });
    await f.session({ assignmentId: assignment.id, status: pastStatus, startedAt: new Date(0), endedAt: new Date(0) });
    expect(await loadSharedSession(code)).toMatchObject({ kind: "session", props: { sessionCode: code, minutesLeft: 2 } });
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status, expiresAt: new Date(0) });
  });

  test.each(["cancelled", "expired"])("loadSharedSession rejects %s status despite available minutes", async (status) => {
    await balance(120);
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
    expect(await loadSharedSession(code)).toEqual({ kind: "outOfMinutes", email: f.learner.email });
  });

  test("loadOrgHome lists pending and used role plays regardless of practice history or expiry date", async () => {
    const original = await db.rolePlayAssignment.findUniqueOrThrow({ where: { shareCode: code } });
    const visible: string[] = [];
    for (const status of ["pending", "used", "cancelled", "expired"]) {
      for (const past of [true, false]) {
        const shareCode = `${code}-${status}-${past}`;
        const assignment = await db.rolePlayAssignment.create({ data: {
          orgId: f.org.id, deploymentId: original.deploymentId, recipientEmail: f.learner.email,
          assignedByUserId: f.trainer.id, status, shareCode,
          expiresAt: past ? new Date(0) : new Date(Date.now() + 3600_000),
        } });
        if (status === "used") await f.session({ assignmentId: assignment.id });
        if (status === "pending" || status === "used") visible.push(`/s/${shareCode}`);
      }
    }
    await db.rolePlayAssignment.create({ data: {
      orgId: f.org.id, deploymentId: original.deploymentId, recipientEmail: f.trainer.email,
      assignedByUserId: f.trainer.id, status: "pending", shareCode: `${code}-someone-else`, expiresAt: new Date(0),
    } });
    const home = await loadOrgHome();
    expect(home.kind).toBe("home");
    if (home.kind !== "home") throw new Error("Expected org home");
    expect(home.props.roleplays.map((roleplay) => roleplay.href).sort()).toEqual([`/s/${code}`, ...visible].sort());
  });

  test("roleplay scenarios.get keeps an old pending member pending rather than deriving expired", async () => {
    await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { source: ROLEPLAY_SOURCE } } });
    const assignment = await db.rolePlayAssignment.update({ where: { shareCode: code }, data: { expiresAt: new Date(0) } });
    const caller = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
    const scenario = await caller.scenarios.get({ slug: f.roleplay.slug });
    expect(scenario.members).toMatchObject([{ id: assignment.id, status: "pending" }]);
    expect((await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe("pending");
  });

  test.each([0, 59])("shared session shows outOfMinutes with %s seconds left", async (seconds) => {
    await balance(seconds);
    expect(await loadSharedSession(code)).toEqual({ kind: "outOfMinutes", email: f.learner.email });
  });

  test.each([60, 119, 120])("shared session passes floored minutesLeft with %s seconds left", async (seconds) => {
    await balance(seconds);
    expect(await loadSharedSession(code)).toMatchObject({ kind: "session", props: { minutesLeft: Math.floor(seconds / 60) } });
  });

  test.each(["admin", "team"])("studio %s sees no metering on shared sessions or twin preview", async (role) => {
    if (role === "admin") await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role: "team" } });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role } });
    expect(await loadSharedSession(code)).toMatchObject({ kind: "session", props: { minutesLeft: null } });
    const view = await loadTwinLink("twin");
    expect(view).toMatchObject({ kind: "flow", props: { access: { ok: true, preview: true } } });
    if (view.kind === "flow") expect(view.props.access).not.toHaveProperty("minutesLeft");
  });

  test("assigned twin shows used below a minute, then passes minutesLeft and minutesTotal", async () => {
    await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, recipientEmail: f.learner.email, minutesLimit: 999, shareCode: `${code}-twin` } });
    expect(await loadTwinLink("twin")).toMatchObject({ kind: "flow", props: { access: { ok: false, reason: "used" } } });
    await balance(119);
    expect(await loadTwinLink("twin")).toMatchObject({ kind: "flow", props: { access: { ok: true, preview: false, minutesLeft: 1, minutesTotal: 2 } } });
  });

  test("Users page shares the same floored learner balance across modules", async () => {
    await balance(119);
    const rows = await listUsers(f.org.id);
    expect(rows.find((r) => r.email === f.learner.email)).toMatchObject({ minutesLeft: 1, roleplaySessions: 1, twinSessions: 0 });
    expect(rows.find((r) => r.email === f.trainer.email)).toBeUndefined();
  });

  test.each(["admin", "team"])("listUsers gives null minutesLeft to an email with both learner and %s memberships", async (role) => {
    await balance(119);
    await db.member.create({ data: {
      id: `${f.learner.id}-studio-member`, userId: f.learner.id, organizationId: f.org.id, role, createdAt: new Date(),
    } });
    // Keep the learner membership and assignment so this remains a Users-page row.
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: f.learner.id } })).toBe(2);
    const rows = await listUsers(f.org.id);
    expect(rows.find((row) => row.email === f.learner.email)).toMatchObject({ minutesLeft: null });
  });

  test("a new common-link visitor can reach the session before starting minutes are granted", async () => {
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${code}-common`, minutesPerUser: 30 } });
    expect(await loadSharedSession(link.code)).toMatchObject({ kind: "session", props: { minutesLeft: null } });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
