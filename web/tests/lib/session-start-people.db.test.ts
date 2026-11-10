import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { activateSession } from "@/lib/interview-sessions";
import { TwinAccessError } from "@/lib/twin-access";

// specs/people.md rule 6: session start never creates a member; it refuses someone who isn't one.
describe.skipIf(!localMinutesDb)("session start and org membership (local database)", () => {
  let f: MinutesFixture;
  const outsider = () => ({ id: `${f.org.id}-outsider`, email: `outsider-${f.org.id}@example.com` });
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    await db.user.create({ data: { ...outsider(), name: "Outsider", emailVerified: true } });
  });
  afterEach(async () => { await f.clean(); await db.user.deleteMany({ where: { id: outsider().id } }); });

  test("an account outside the org starting a role play directly is refused and is NOT added to the org", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    // Credits under their email (as if left over), so the refusal is about membership, not minutes.
    await db.minuteLedger.create({ data: { orgId: f.org.id, email: outsider().email, type: "grant", seconds: 1800 } });
    const error = await activateSession({ orgId: f.org.id, userId: outsider().id, userEmail: outsider().email, agentSlug: f.roleplay.slug, mode: "voice" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwinAccessError);
    expect(error).toMatchObject({ status: 403, message: expect.stringContaining("not a member") });
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: outsider().id } })).toBe(0);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("an account outside the org can't use a twin directly, and is not added either", async () => {
    await expect(activateSession({ orgId: f.org.id, userId: outsider().id, userEmail: outsider().email, agentSlug: f.twin.slug, mode: "voice" }))
      .rejects.toMatchObject({ name: "TwinAccessError", status: 403 });
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: outsider().id } })).toBe(0);
  });

  test("activateSession through a common code refuses a non-member and creates no member, assignment, grant or session", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 60 });
    const grant = await db.minuteLedger.create({ data: { orgId: f.org.id, email: outsider().email, type: "grant", seconds: 1800 } });
    const link = await db.twinShareLink.create({ data: { orgId: f.org.id, agentId: f.twin.id, code: `${f.org.id}-common`, minutesPerUser: 30, createdByUserId: f.trainer.id } });
    await expect(activateSession({ orgId: f.org.id, userId: outsider().id, userEmail: outsider().email, shareCode: link.code, mode: "voice" }))
      .rejects.toMatchObject({ name: "TwinAccessError", status: 403, message: expect.stringContaining("not a member") });
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: outsider().id } })).toBe(0);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id } })).toEqual([grant]);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
