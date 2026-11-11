import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { addPeopleToOrg, orgPerson } from "@/lib/org-people";
import { changeMemberRole, setMemberDisabled } from "@/lib/members";
import * as sessionEnd from "@/lib/session-end";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("Module 1 real PostgreSQL people-lock races", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 300 }); });
  afterEach(async () => { await f.clean(); });
  const add = (email: string) => addPeopleToOrg({ orgId: f.org.id, emails: [email], role: "user", byUserId: f.trainer.id });
  const disable = () => setMemberDisabled({ orgId: f.org.id, memberId: `${f.learner.id}-member`, actorUserId: f.trainer.id, disabled: true });
  test("two concurrent adds for a new email create one account, one member and exactly one starting grant", async () => {
    const email = `race-${f.org.id}@example.com`;
    const results = await Promise.all([add(email), add(email.toUpperCase())]);
    expect(await db.user.count({ where: { email } })).toBe(1);
    const person = (await orgPerson(f.org.id, { email }))!;
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: person.userId } })).toBe(1);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id, email, type: "grant" } })).toEqual([expect.objectContaining({ seconds: 1800, note: "Starting minutes" })]);
    expect(results.flat().filter((person) => person.added)).toHaveLength(1);
    expect(results.flat().reduce((sum, person) => sum + person.startingCredits, 0)).toBe(30);
  });
  test("addPeopleToOrg racing disable rechecks membership and never gives a disabled person fresh credits", async () => {
    const results = await Promise.allSettled([add(f.learner.email), disable()]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ status: 409, code: "person_disabled" });
    else expect(results[0].value[0]).toMatchObject({ added: false, startingCredits: 0 });
    expect(await orgPerson(f.org.id, { email: f.learner.email })).toMatchObject({ disabled: true });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, email: f.learner.email } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id, userId: f.learner.id, status: "active" } })).toBe(0);
    expect(await db.rolePlayAssignment.count({ where: { memberId: `${f.learner.id}-member`, status: "pending" } })).toBe(0);
  });
  test("addPeopleToOrg racing learner-to-team never gives the studio member a fresh starting grant", async () => {
    const results = await Promise.allSettled([add(f.learner.email), changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" })]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ status: 409, code: "person_is_studio" });
    else expect(results[0].value[0]).toMatchObject({ added: false, startingCredits: 0 });
    expect(await orgPerson(f.org.id, { email: f.learner.email })).toMatchObject({ role: "team" });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, email: f.learner.email } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id, userId: f.learner.id } })).toBe(0);
    expect(await db.rolePlayAssignment.count({ where: { memberId: `${f.learner.id}-member` } })).toBe(0);
  });
  test("BUG repeat disable must retry a failed workflow dispatch after finalization (actual no retry of abandoned call)", async () => {
    const call = await f.session({ status: "active", endedAt: null, startedAt: new Date(Date.now() - 60_000) });
    const end = spyOn(sessionEnd, "startSessionEnd").mockRejectedValueOnce(new Error("LiveKit end workflow could not start")).mockResolvedValue(undefined);
    try {
      await expect(disable()).rejects.toMatchObject({ code: "calls_not_ended", status: 500, message: "Disabled, but 1 call(s) in progress could not be ended yet. Disable again to retry." });
      expect(await orgPerson(f.org.id, { email: f.learner.email })).toMatchObject({ disabled: true });
      expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "abandoned" });
      expect(await db.minuteLedger.count({ where: { sessionId: call.id, type: "usage" } })).toBe(1);
      await disable();
      expect(end).toHaveBeenCalledTimes(2);
      expect(end).toHaveBeenLastCalledWith(call.id);
      expect(await db.minuteLedger.count({ where: { sessionId: call.id, type: "usage" } })).toBe(1);
    } finally { end.mockRestore(); }
  });
  test("concurrent disables dispatch the call end once", async () => {
    const call = await f.session({ status: "active", endedAt: null, startedAt: new Date(Date.now() - 60_000) });
    const end = spyOn(sessionEnd, "startSessionEnd").mockResolvedValue(undefined);
    try {
      await Promise.all([disable(), disable()]);
      const ended = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
      expect(ended).toMatchObject({ status: "abandoned", runtimeTokenHash: null, endedAt: expect.any(Date) });
      expect(end).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith(call.id);
      expect(await db.minuteLedger.count({ where: { sessionId: call.id, type: "usage" } })).toBe(1);
    } finally { end.mockRestore(); }
  });
});
