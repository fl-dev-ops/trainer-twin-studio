import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as email from "@/lib/email";
import * as externalApi from "@/lib/external-api";
import { POST } from "@/app/api/v1/assignments/route";
import { PATCH } from "@/app/api/v1/assignments/[id]/route";
import { grantMinutes, learnerBalance, orgBalanceSeconds, topUpOrg } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("v1 assignment email minutes (local database)", () => {
  let f: MinutesFixture;
  let api: ReturnType<typeof spyOn<typeof externalApi, "requireExternalApi">>;
  let assignmentEmail: ReturnType<typeof spyOn<typeof email, "sendRolePlayAssignmentEmail">>;
  beforeEach(async () => {
    assignmentEmail = spyOn(email, "sendRolePlayAssignmentEmail").mockResolvedValue({ success: true });
    f = minutesFixture();
    await f.create();
    api = spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, actorUserId: f.trainer.id, keyId: "test-key" });
  });
  afterEach(async () => { api?.mockRestore(); assignmentEmail?.mockRestore(); await f.clean(); });
  const request = (method: string, body: unknown) => new Request("https://example.com/api/v1/assignments", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const fund = (minutes: number) => topUpOrg({ orgId: f.org.id, minutes, note: "test" });
  const ledger = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
  const post = (body = { email: f.learner.email, scenario: f.roleplay.slug }) => POST(request("POST", body));
  const patch = (id: string, body: unknown) => PATCH(request("PATCH", body), { params: Promise.resolve({ id }) });
  const createAssignment = async () => {
    const response = await post();
    expect(response.status).toBe(201);
    const { assignment } = await response.json();
    assignmentEmail.mockClear();
    return db.rolePlayAssignment.findFirstOrThrow({ where: { id: assignment.id, orgId: f.org.id } });
  };

  test("POST grants a new person 30 before emailing their balance", async () => {
    await fund(30);
    const to = `new-${f.learner.email}`;
    const response = await post({ email: to, scenario: f.roleplay.slug });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ emailSent: true, assignment: { email: to } });
    expect((await learnerBalance(f.org.id, to)).balanceSeconds).toBe(1800);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" } })).toMatchObject([
      { email: to, seconds: 1800, actorUserId: f.trainer.id },
    ]);
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to, minutes: 30 }));
  });

  test.each([
    { usedSeconds: 91, expectedMinutes: 33 },
    { usedSeconds: 2161, expectedMinutes: 0 },
  ])("POST emails an existing learner's real balance, floored and nonnegative ($usedSeconds seconds used)", async ({ usedSeconds, expectedMinutes }) => {
    await fund(35);
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 30 });
    await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 5 });
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await f.session({ startedAt, endedAt: new Date(startedAt.getTime() + usedSeconds * 1000), allowedSeconds: usedSeconds });
    const before = await ledger();
    const response = await POST(request("POST", { userId: f.learner.id, scenario: f.roleplay.slug }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ emailSent: true });
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, minutes: expectedMinutes }));
    expect(await ledger()).toEqual(before);
  });

  test("PATCH to a new email grants 30 and emails the new recipient's balance", async () => {
    await fund(60);
    const original = await createAssignment();
    const to = `new-${f.learner.email}`;
    const response = await patch(original.id, { email: to });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, emailSent: true, assignment: { id: original.id, email: to } });
    const updated = await db.rolePlayAssignment.findFirstOrThrow({ where: { orgId: f.org.id, id: original.id } });
    expect(updated.recipientEmail).toBe(to);
    expect(updated.shareCode).not.toBe(original.shareCode);
    expect((await learnerBalance(f.org.id, to)).balanceSeconds).toBe(1800);
    expect(await orgBalanceSeconds(f.org.id)).toBe(0);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id, email: to, type: "grant" } })).toMatchObject([
      { seconds: 1800, actorUserId: f.trainer.id, note: "Starting minutes" },
    ]);
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to, minutes: 30 }));
  });

  test("PATCH with short org balance returns 409, preserving the entire assignment and ledger without email", async () => {
    await fund(59);
    const original = await createAssignment();
    const before = await ledger();
    const to = `new-${f.learner.email}`;
    const response = await patch(original.id, { email: to });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Not enough credits") });
    expect(await db.rolePlayAssignment.findMany({ where: { orgId: f.org.id } })).toEqual([original]);
    expect(await ledger()).toEqual(before);
    expect((await learnerBalance(f.org.id, to)).balanceSeconds).toBe(0);
    expect(await orgBalanceSeconds(f.org.id)).toBe(29 * 60);
    expect(assignmentEmail).not.toHaveBeenCalled();
  });

  test("PATCH scenario only on the same learner sends their balance with no new grant even when the org is empty", async () => {
    await fund(30);
    const original = await createAssignment();
    const persona = await db.persona.findFirstOrThrow({ where: { orgId: f.org.id } });
    const scenario = await db.agent.create({ data: {
      orgId: f.org.id, personaId: persona.id, kind: "ROLEPLAY", slug: `${f.org.slug}-second`, name: "Second scenario", data: {},
    } });
    await f.session(); // 90 seconds used: 28 whole minutes remain.
    const before = await ledger();
    const response = await patch(original.id, { scenario: scenario.slug });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, emailSent: true, assignment: { email: f.learner.email, scenario: scenario.slug } });
    const updated = await db.rolePlayAssignment.findFirstOrThrow({ where: { orgId: f.org.id, id: original.id }, include: { deployment: true } });
    expect(updated.deployment.agentId).toBe(scenario.id);
    expect(await ledger()).toEqual(before);
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.learner.email, rolePlayName: scenario.name, minutes: 28 }));
  });

  test("PATCH to someone with credits preserves all ledger rows and emails their actual balance", async () => {
    await fund(75);
    const original = await createAssignment();
    const to = `existing-${f.learner.email}`;
    await grantMinutes({ orgId: f.org.id, email: to, minutes: 30 });
    await grantMinutes({ orgId: f.org.id, email: to, minutes: 15 });
    const before = await ledger();
    const response = await patch(original.id, { email: to });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, emailSent: true, assignment: { email: to } });
    expect(await ledger()).toEqual(before);
    expect((await learnerBalance(f.org.id, to)).balanceSeconds).toBe(2700);
    expect(assignmentEmail).toHaveBeenCalledTimes(1);
    expect(assignmentEmail).toHaveBeenCalledWith(expect.objectContaining({ to, minutes: 45 }));
  });
});
