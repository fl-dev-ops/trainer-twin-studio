import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as deployments from "@/lib/deployments";
import * as externalApi from "@/lib/external-api";
import * as delivery from "@/lib/external-api-assignments";
import { POST } from "@/app/api/v1/assignments/route";
import { GET, PATCH } from "@/app/api/v1/assignments/[id]/route";
import { assignRoleplayLearners, inviteToRoleplay } from "@/lib/invite/roleplay";
import { setMemberDisabled } from "@/lib/members";
import { runCopilotStudio, type CopilotStudioDeps } from "@/lib/copilot-studio";
import { availableOrgSeconds, fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("Module 4 atomic role-play assignment services and REST routes", () => {
  let f: MinutesFixture;
  let deployment: Awaited<ReturnType<typeof deployments.ensureDeployment>>;
  const spies: { mockRestore(): void }[] = [];
  let email: ReturnType<typeof spyOn<typeof delivery, "emailAssignment">>;
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    deployment = await deployments.ensureDeployment(f.org.id, f.roleplay.id);
    email = spyOn(delivery, "emailAssignment").mockResolvedValue(true);
    spies.push(email, spyOn(externalApi, "requireExternalApi").mockResolvedValue({ org: f.org, trainer: { memberId: `${f.trainer.id}-member`, userId: f.trainer.id, ...f.trainer, image: null, role: "admin", disabled: false, disabledAt: null, addedAt: new Date() }, actorUserId: f.trainer.id, keyId: "test-key" }));
  });
  afterEach(async () => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); await f.clean(); });
  const assign = (emails = [f.learner.email]) => assignRoleplayLearners({ org: f.org, by: f.trainer, agent: f.roleplay, emails });
  const disable = () => setMemberDisabled({ orgId: f.org.id, memberId: `${f.learner.id}-member`, actorUserId: f.trainer.id, disabled: true });
  const link = (status = "pending") => db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${f.learner.id}-member`, assignedByUserId: f.trainer.id, shareCode: `${f.org.id}-link`, expiresAt: new Date(0), status } });
  const snapshot = () => Promise.all([
    db.member.findMany({ where: { organizationId: f.org.id }, orderBy: { id: "asc" } }),
    db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } }),
    db.rolePlayAssignment.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } }),
  ]);
  const request = (method: string, body: unknown) => new Request("https://test/api/v1/assignments", { method, body: JSON.stringify(body) });
  const post = (by: { email?: string; userId?: string }, scenario = f.roleplay.slug) => POST(request("POST", { ...by, scenario }));
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const patch = (id: string, by: { email?: string; userId?: string; scenario?: string }) => PATCH(request("PATCH", by), params(id));

  test("a failing link write rolls back the whole batch's accounts, memberships and starting credits", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    const before = await snapshot();
    const emails = [`new-a-${f.org.id}@example.com`, `new-b-${f.org.id}@example.com`];
    // Force a real FK refusal at the link write, after addPeopleToOrg has staged people/grants.
    spies.push(spyOn(deployments, "ensureDeployment").mockResolvedValue({ ...deployment, id: `${f.org.id}-missing-deployment` }));
    await expect(assign(emails)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await db.user.count({ where: { email: { in: emails } } })).toBe(0);
    expect(await availableOrgSeconds(f.org.id)).toBe(6000);
  });

  test.each(["pending", "used"])("disable cancels a legacy %s link without deleting its practice history", async (status) => {
    const original = await link(status); const session = await f.session({ assignmentId: original.id });
    await disable();
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: "cancelled", shareCode: original.shareCode });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
  });

  test("assign versus disable race leaves no open link for the disabled learner", async () => {
    const results = await Promise.allSettled([assign(), disable()]);
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "person_disabled", status: 409 });
    expect(await db.member.findUniqueOrThrow({ where: { id: `${f.learner.id}-member` } })).toMatchObject({ disabledAt: expect.any(Date) });
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id, status: { in: ["pending", "used"] } } })).toBe(0);
    await expect(assign()).rejects.toMatchObject({ code: "person_disabled", status: 409 });
  });

  test("double assignment serializes to one pending link and one assignment email", async () => {
    const results = await Promise.all([assign(), assign()]);
    expect(results.map((result) => result.stats.added).sort()).toEqual([0, 1]);
    expect(results.flatMap((result) => result.emails)).toHaveLength(1);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id, status: "pending" } })).toBe(1);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test.each(["person_disabled", "person_is_studio"] as const)("refuses %s for the whole dashboard batch with no people, links or credits written", async (code) => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: code === "person_disabled" ? { disabledAt: new Date() } : { role: "team" } });
    const before = await snapshot(); const newcomer = `batch-${f.org.id}@example.com`;
    await expect(assign([newcomer, f.learner.email])).rejects.toMatchObject({ code, status: 409 });
    expect(await snapshot()).toEqual(before);
    expect(await db.user.count({ where: { email: newcomer } })).toBe(0);
    expect(await availableOrgSeconds(f.org.id)).toBe(6000);
  });

  test("refuses person_is_studio when the copilot batch contains a team email; nothing is written", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 100 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { role: "team" } });
    const before = await snapshot(); const newcomer = `copilot-${f.org.id}@example.com`;
    // Real membership validation + assignment transaction; no workflow or email transport is needed on refusal.
    const deps = { db, inviteToRoleplay } as unknown as CopilotStudioDeps;
    await expect(runCopilotStudio({ org: f.org, user: f.trainer }, { action: "inviteLearners", slug: f.roleplay.slug, emails: [newcomer, f.learner.email] }, deps)).rejects.toMatchObject({ code: "person_is_studio", status: 409 });
    expect(await snapshot()).toEqual(before);
    expect(await db.user.count({ where: { email: newcomer } })).toBe(0);
    expect(await availableOrgSeconds(f.org.id)).toBe(6000);
  });

  test.each(["email", "userId"] as const)("REST POST by %s creates once and returns the same open link without another email", async (by) => {
    const input = by === "email" ? { email: f.learner.email } : { userId: f.learner.id };
    const first = await post(input); expect(first.status).toBe(201); const created = await first.json();
    const before = await snapshot();
    const repeated = await post(input); expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ created: false, assignment: created.assignment, practiceUrl: created.practiceUrl });
    expect(await snapshot()).toEqual(before); expect(email).toHaveBeenCalledTimes(1);
  });

  test.each([
    { by: "email", code: "person_disabled" }, { by: "userId", code: "person_disabled" },
    { by: "email", code: "person_is_studio" }, { by: "userId", code: "person_is_studio" },
    { by: "userId", code: "not_found" },
  ] as const)("REST POST by $by refuses $code without writes", async ({ by, code }) => {
    if (code !== "not_found") await db.member.update({ where: { id: `${f.learner.id}-member` }, data: code === "person_disabled" ? { disabledAt: new Date() } : { role: "team" } });
    const before = await snapshot();
    const response = await post(by === "email" ? { email: f.learner.email } : { userId: code === "not_found" ? `${f.org.id}-unknown` : f.learner.id });
    expect(response.status).toBe(code === "not_found" ? 404 : 409);
    expect(await response.json()).toEqual({ code, error: code === "not_found" ? "Not found." : code === "person_disabled" ? `${f.learner.email} is disabled in this organization. Re-enable them first.` : `${f.learner.email} is on the team. Team members practise with the organization's credits, not as learners.` });
    expect(await snapshot()).toEqual(before); expect(email).not.toHaveBeenCalled();
  });

  test.each(["learner", "scenario"] as const)("REST PATCH move to another %s cancels the old link; sessions and practice counts keep their old id", async (target) => {
    const original = await link(); const session = await f.session({ assignmentId: original.id });
    let change: { userId?: string; scenario?: string };
    if (target === "learner") {
      const user = await db.user.create({ data: { id: `${f.org.id}-target`, email: `target-${f.org.id}@example.com`, name: "Target", emailVerified: true } });
      await db.member.create({ data: { id: `${user.id}-member`, userId: user.id, organizationId: f.org.id, role: "user", createdAt: new Date() } });
      change = { userId: user.id };
    } else {
      const persona = await db.persona.findFirstOrThrow({ where: { orgId: f.org.id } });
      const agent = await db.agent.create({ data: { orgId: f.org.id, personaId: persona.id, slug: `${f.org.id}-target`, name: "Target scenario", kind: "ROLEPLAY", data: {} } });
      change = { scenario: agent.slug };
    }
    const response = await patch(original.id, change); expect(response.status).toBe(200); const moved = await response.json();
    expect(moved).toMatchObject({ changed: true }); expect(moved.assignment.id).not.toBe(original.id);
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: "cancelled", shareCode: original.shareCode, memberId: original.memberId, deploymentId: original.deploymentId });
    expect(await db.rolePlayAssignment.findUniqueOrThrow({ where: { id: moved.assignment.id } })).toMatchObject({ status: "pending", usedAt: null });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
    for (const [id, practiceCount] of [[original.id, 1], [moved.assignment.id, 0]] as const) {
      expect(await (await GET(new Request("https://test"), params(id))).json()).toMatchObject({ assignment: { id, practiceCount } });
    }
  });

  test("refuses assignment_exists when REST PATCH targets a learner with an open link; the old link stays open", async () => {
    const original = await link();
    const user = await db.user.create({ data: { id: `${f.org.id}-target`, email: `target-${f.org.id}@example.com`, name: "Target", emailVerified: true } });
    await db.member.create({ data: { id: `${user.id}-member`, userId: user.id, organizationId: f.org.id, role: "user", createdAt: new Date() } });
    await db.rolePlayAssignment.create({ data: { orgId: f.org.id, deploymentId: deployment.id, memberId: `${user.id}-member`, shareCode: `${f.org.id}-target-link`, expiresAt: new Date(0), assignedByUserId: f.trainer.id } });
    const before = await snapshot();
    const response = await patch(original.id, { userId: user.id });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "assignment_exists", error: "That learner already has this role play." });
    expect(await snapshot()).toEqual(before); expect(email).not.toHaveBeenCalled();
  });
});
