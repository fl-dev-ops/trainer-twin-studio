import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as externalApi from "@/lib/external-api";
import * as email from "@/lib/email";
import { POST as inviteUser } from "@/app/api/v1/users/route";
import { POST as assignRoleplay } from "@/app/api/v1/assignments/route";
import { orgHomeUrl } from "@/lib/invite/links";
import { learnerBalance } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("v1 minutes entrypoints (local database)", () => {
  let f: MinutesFixture;
  let api: ReturnType<typeof spyOn<typeof externalApi, "requireExternalApi">>;
  let invitationEmail: ReturnType<typeof spyOn<typeof email, "sendPersonEmail">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    api = spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, actorUserId: f.trainer.id, keyId: "test-key" });
    invitationEmail = spyOn(email, "sendPersonEmail").mockResolvedValue({ success: true });
  });
  afterEach(async () => { api?.mockRestore(); invitationEmail?.mockRestore(); await f.clean(); });
  const request = (body: unknown) => new Request("https://example.com/api/v1/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const fund = (amount: number) => fundOrg({ orgId: f.org.id, minutes: amount, note: "test" });

  test("POST /users returns 409 without an invitation or mail when starting minutes are short", async () => {
    await fund(29);
    const response = await inviteUser(request({ email: `new-${f.learner.email}` }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Not enough credits") });
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
    expect(invitationEmail).not.toHaveBeenCalled();
  });

  test("POST /users grants 30 once, creates a member immediately, and a repeat sends no second email", async () => {
    await fund(30);
    const email = `new-${f.learner.email}`;
    expect((await inviteUser(request({ email: email.toUpperCase() }))).status).toBe(201);
    expect((await inviteUser(request({ email }))).status).toBe(200);
    expect((await learnerBalance(f.org.id, email)).balanceSeconds).toBe(1800);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(invitationEmail).toHaveBeenCalledTimes(1);
    expect(invitationEmail.mock.calls[0][0].added?.signInUrl).toBe(orgHomeUrl(f.org.slug));
  });

  test("POST /assignments returns 409 without assignment or mail when starting minutes are short", async () => {
    await fund(29);
    const response = await assignRoleplay(request({ email: f.learner.email, scenario: f.roleplay.slug }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Not enough credits") });
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(0);
    expect(invitationEmail).not.toHaveBeenCalled();
  });

  test("POST /assignments grants 30 once; idempotent and reopened assignments need no further credit", async () => {
    await fund(30);
    const body = { email: f.learner.email, scenario: f.roleplay.slug };
    const first = await assignRoleplay(request(body));
    expect(first.status).toBe(201);
    const created = await first.json();
    const repeat = await assignRoleplay(request(body));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ created: false, assignment: { id: created.assignment.id } });
    await db.rolePlayAssignment.update({ where: { id: created.assignment.id }, data: { status: "cancelled" } });
    expect((await assignRoleplay(request(body))).status).toBe(201);
    expect((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds).toBe(1800);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "grant" } })).toBe(1);
    expect(invitationEmail).toHaveBeenCalledTimes(2);
  });
});
