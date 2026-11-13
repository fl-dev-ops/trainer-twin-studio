import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as externalApi from "@/lib/external-api";
import { GET as listSessions } from "@/app/api/v1/sessions/route";
import { GET as getSession } from "@/app/api/v1/sessions/[id]/route";
import { GET as listAssignments } from "@/app/api/v1/assignments/route";
import { GET as getAssignment } from "@/app/api/v1/assignments/[id]/route";
import { ensureDeployment } from "@/lib/deployments";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("v1 role-play practice (local database)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let api: ReturnType<typeof spyOn<typeof externalApi, "requireExternalApi">>;
  let assignment: { id: string };
  let unpractised: { id: string; deploymentId: string };
  let foreign: { id: string };
  const request = (path: string) => new Request(`https://example.com/api/v1/${path}`);
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const assign = async (fixture: MinutesFixture, suffix: string) => {
    const agentId = suffix === "unpractised" ? (await db.agent.create({ data: {
      orgId: fixture.org.id, personaId: (await db.persona.findFirstOrThrow({ where: { orgId: fixture.org.id } })).id,
      slug: `${fixture.org.slug}-unpractised`, name: "Unpractised scenario", kind: "ROLEPLAY", data: {},
    } })).id : fixture.roleplay.id;
    const deployment = await ensureDeployment(fixture.org.id, agentId);
    return db.rolePlayAssignment.create({ data: {
      orgId: fixture.org.id, deploymentId: deployment.id, memberId: `${fixture.learner.id}-member`,
      assignedByUserId: fixture.trainer.id, shareCode: `${fixture.org.id}-${suffix}`, expiresAt: new Date(0),
    } });
  };
  beforeEach(async () => {
    f = minutesFixture(); other = minutesFixture();
    await f.create(); await other.create();
    api = spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, trainer: { memberId: `${f.trainer.id}-member`, userId: f.trainer.id, ...f.trainer, image: null, role: "admin", disabled: false, disabledAt: null, addedAt: new Date() }, actorUserId: f.trainer.id, keyId: "test-key" });
    assignment = await assign(f, "practised");
    unpractised = await assign(f, "unpractised");
    foreign = await assign(other, "foreign");
  });
  afterEach(async () => { api?.mockRestore(); await other.clean(); await f.clean(); });

  test("GET /sessions includes assignmentId, including null for an unassigned call; GET /sessions/:id agrees", async () => {
    const assigned = await f.session({ assignmentId: assignment.id });
    const direct = await f.session();
    const response = await listSessions(request("sessions"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination.total).toBe(2);
    expect(body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: assigned.id, assignmentId: assignment.id }),
      expect.objectContaining({ id: direct.id, assignmentId: null }),
    ]));
    for (const session of [assigned, direct]) {
      const detail = await getSession(request(`sessions/${session.id}`), params(session.id));
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ session: { id: session.id, assignmentId: session.assignmentId } });
    }
  });

  test("GET /sessions?assignmentId returns every practice of only that assignment and paginates the filtered count", async () => {
    const first = await f.session({ assignmentId: assignment.id });
    const second = await f.session({ assignmentId: assignment.id, status: "abandoned" });
    await f.session({ agentId: (await db.deployment.findUniqueOrThrow({ where: { id: unpractised.deploymentId } })).agentId, assignmentId: unpractised.id });
    await f.session();
    await other.session({ assignmentId: foreign.id });
    const response = await listSessions(request(`sessions?assignmentId=${assignment.id}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions.map((session: { id: string }) => session.id).sort()).toEqual([first.id, second.id].sort());
    expect(body.pagination.total).toBe(2);
    expect(body.sessions.every((session: { assignmentId: string }) => session.assignmentId === assignment.id)).toBe(true);
    const page = await listSessions(request(`sessions?assignmentId=${assignment.id}&limit=1&offset=1`));
    expect(await page.json()).toMatchObject({ sessions: [expect.objectContaining({ assignmentId: assignment.id })], pagination: { total: 2, limit: 1, offset: 1 } });
    const filtered = await listSessions(request(`sessions?assignmentId=${assignment.id}&status=abandoned`));
    expect(await filtered.json()).toMatchObject({ sessions: [{ id: second.id }], pagination: { total: 1 } });
  });

  test("GET /sessions?assignmentId for another org or an unknown assignment returns nothing", async () => {
    const session = await other.session({ assignmentId: foreign.id });
    await f.session({ assignmentId: assignment.id });
    for (const id of [foreign.id, `${f.org.id}-unknown`]) {
      const response = await listSessions(request(`sessions?assignmentId=${id}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sessions: [], pagination: { total: 0 } });
    }
    expect((await getSession(request(`sessions/${session.id}`), params(session.id))).status).toBe(404);
  });

  test("assignment list and detail count started, non-failed practices and use the latest qualifying startedAt", async () => {
    const first = new Date("2026-01-01T00:00:00Z");
    const latest = new Date("2026-02-01T00:00:00Z");
    await f.session({ assignmentId: assignment.id, startedAt: first });
    await f.session({ assignmentId: assignment.id, status: "abandoned", startedAt: latest });
    await f.session({ assignmentId: assignment.id, status: "failed", startedAt: new Date("2026-03-01T00:00:00Z") });
    await f.session({ assignmentId: assignment.id, status: "activating", startedAt: null, endedAt: null });
    await f.session({ agentId: (await db.deployment.findUniqueOrThrow({ where: { id: unpractised.deploymentId } })).agentId, assignmentId: unpractised.id, status: "failed" });
    await f.session({ agentId: (await db.deployment.findUniqueOrThrow({ where: { id: unpractised.deploymentId } })).agentId, assignmentId: unpractised.id, status: "assigned", startedAt: null, endedAt: null });
    await f.session(); // A practice of the same role play, but not of this assignment.
    await other.session({ assignmentId: foreign.id });
    const expected = [
      { id: assignment.id, practiceCount: 2, lastPracticedAt: latest.toISOString() },
      { id: unpractised.id, practiceCount: 0, lastPracticedAt: null },
    ];
    const list = await listAssignments(request("assignments"));
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.pagination.total).toBe(2);
    expect(body.assignments).toEqual(expect.arrayContaining(expected.map((value) => expect.objectContaining(value))));
    for (const value of expected) {
      const detail = await getAssignment(request(`assignments/${value.id}`), params(value.id));
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ assignment: value });
    }
    expect((await getAssignment(request(`assignments/${foreign.id}`), params(foreign.id))).status).toBe(404);
  });

  test("an active started practice counts without needing an end time", async () => {
    const startedAt = new Date("2026-02-01T00:00:00Z");
    await f.session({ assignmentId: assignment.id, status: "active", startedAt, endedAt: null });
    const response = await getAssignment(request(`assignments/${assignment.id}`), params(assignment.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ assignment: { practiceCount: 1, lastPracticedAt: startedAt.toISOString() } });
  });
});
