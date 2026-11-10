import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/auth/[...all]/route";
import * as email from "@/lib/email";
import { addPeopleToOrg, orgPerson } from "@/lib/org-people";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { dropLearnerAssignments } from "@/lib/members";
import { ensureDeployment } from "@/lib/deployments";
import { listTwinAssignments } from "@/lib/twin-access";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { listSpecSummaries } from "@/lib/specs";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("people sign in with email codes, never passwords or invitations", () => {
  let f: MinutesFixture;
  let send: ReturnType<typeof spyOn<typeof email, "sendOtpEmail">>;
  const post = (path: string, body: unknown, cookie?: string) => POST(new Request(`https://dash.${BASE_DOMAIN}/api/auth/${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: `https://dash.${BASE_DOMAIN}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const cookies = (response: Response) => response.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
  const otp = (email: string) => auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  beforeEach(async () => { f = minutesFixture(); await f.create(); send = spyOn(email, "sendOtpEmail").mockResolvedValue({ success: true }); });
  afterEach(async () => {
    send?.mockRestore();
    await db.verification.deleteMany({ where: { identifier: { contains: f.org.id } } });
    await db.founderInvite.deleteMany({ where: { email: { contains: f.org.id } } });
    await f.clean();
  });

  test.each([
    ["sign-in/email", { password: "not-a-way-in" }],
    ["sign-up/email", { name: "Password user", password: "not-a-way-in" }],
    ["change-password", { currentPassword: "not-a-way-in", newPassword: "still-not-a-way-in" }],
    ["request-password-reset", { redirectTo: `https://dash.${BASE_DOMAIN}/reset-password` }],
    ["reset-password", { token: "not-a-reset-token", newPassword: "not-a-way-in" }],
    ["verify-password", { password: "not-a-way-in" }],
    ["forget-password/email-otp", {}],
    ["email-otp/request-password-reset", {}],
    ["email-otp/reset-password", { otp: "123456", password: "not-a-way-in" }],
  ] as const)("POST /api/auth/%s is not mounted and returns 404", async (path, body) => {
    const user = await db.user.findUniqueOrThrow({ where: { id: f.trainer.id } });
    const response = await post(path, { email: f.trainer.email, ...body });
    expect(response.status).toBe(404);
    expect(await db.user.findUniqueOrThrow({ where: { id: f.trainer.id } })).toEqual(user);
    expect(await db.session.count({ where: { userId: f.trainer.id } })).toBe(0);
    expect(await db.account.count({ where: { userId: f.trainer.id, providerId: "credential" } })).toBe(0);
    expect(await db.verification.count({ where: { identifier: { contains: f.trainer.email } } })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  test("email OTP signs in an unverified account created by addPeopleToOrg and keeps its account and membership", async () => {
    await fundOrg({ orgId: f.org.id, minutes: 30 });
    const [person] = await addPeopleToOrg({ orgId: f.org.id, emails: [`added-${f.org.id}@example.com`], role: "user", byUserId: f.trainer.id });
    expect(await db.user.findUniqueOrThrow({ where: { id: person.userId } })).toMatchObject({ emailVerified: false });
    const sent = await post("email-otp/send-verification-otp", { email: person.email, type: "sign-in" });
    expect(sent.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const code = send.mock.calls[0][0].otp;
    expect(code).toMatch(/^\d{6}$/);
    const verification = await db.verification.findFirstOrThrow({ where: { identifier: { contains: person.email } } });
    expect(verification.value).not.toContain(code); // hashed at rest
    expect(verification.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(verification.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    const response = await post("sign-in/email-otp", { email: person.email, otp: code });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: person.userId, email: person.email, emailVerified: true } });
    expect(cookies(response)).toBeTruthy();
    expect(await orgPerson(f.org.id, { userId: person.userId })).toMatchObject({ memberId: person.memberId, role: "user" });
    expect(await db.member.count({ where: { organizationId: f.org.id, userId: person.userId } })).toBe(1);
    expect((await post("sign-in/email-otp", { email: person.email, otp: code })).status).not.toBe(200);
  });

  test("unknown emails receive no code and cannot create an account, even with a server-generated OTP", async () => {
    const address = `signup-${f.org.id}@example.com`;
    const sent = await post("email-otp/send-verification-otp", { email: address, type: "sign-in" });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ success: true });
    expect(send).not.toHaveBeenCalled();
    expect(await db.verification.count({ where: { identifier: { contains: address } } })).toBe(0);
    expect(await db.user.findUnique({ where: { email: address } })).toBeNull();
    const invented = await post("sign-in/email-otp", { email: address, otp: "123456" });
    expect(invented.status).toBe(400);
    expect(await invented.json()).toMatchObject({ code: "INVALID_OTP" });
    const response = await post("sign-in/email-otp", { email: address, otp: await otp(address), name: "New User" });
    expect(response.status).toBe(400);
    expect(await db.user.findUnique({ where: { email: address } })).toBeNull();
  });

  test("the founder invite script creates an account that can sign in without self-sign-up", async () => {
    const address = `founder-${f.org.id}@example.com`;
    const child = Bun.spawn([process.execPath, "scripts/founder-invite.ts", ` ${address.toUpperCase()} `], {
      env: process.env, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const invite = await db.founderInvite.findUniqueOrThrow({ where: { token: new URL(stdout.trim()).searchParams.get("t")! } });
    expect(invite.email).toBe(address);
    const user = await db.user.findUniqueOrThrow({ where: { email: address } });
    expect(user).toMatchObject({ emailVerified: false, name: address.split("@")[0] });
    const repeated = Bun.spawn([process.execPath, "scripts/founder-invite.ts", address], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [repeatOut, repeatError, repeatCode] = await Promise.all([new Response(repeated.stdout).text(), new Response(repeated.stderr).text(), repeated.exited]);
    expect(repeatCode).toBe(1);
    expect(repeatOut).toBe("");
    expect(repeatError).toContain("already registered");
    expect(await db.founderInvite.count({ where: { email: address } })).toBe(1);
    expect(await db.user.findUnique({ where: { email: address } })).toEqual(user);
    const response = await post("sign-in/email-otp", { email: address, otp: await otp(address) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: user.id, emailVerified: true } });
    expect(await db.member.count({ where: { userId: user.id } })).toBe(0);
  });

  test("wrong or expired codes cannot sign in; three wrong tries exhaust the code", async () => {
    const code = await otp(f.learner.email);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 3; attempt++) expect((await post("sign-in/email-otp", { email: f.learner.email, otp: wrong })).status).not.toBe(200);
    expect((await post("sign-in/email-otp", { email: f.learner.email, otp: code })).status).not.toBe(200);
    const fresh = await otp(f.learner.email);
    await db.verification.updateMany({ where: { identifier: { contains: f.learner.email } }, data: { expiresAt: new Date(0) } });
    expect((await post("sign-in/email-otp", { email: f.learner.email, otp: fresh })).status).not.toBe(200);
    expect(await db.session.count({ where: { userId: f.learner.id } })).toBe(0);
  });

  const assignments = async (fixture = f) => {
    const deployment = await ensureDeployment(fixture.org.id, fixture.roleplay.id);
    const twin = await db.twinAssignment.create({ data: { orgId: fixture.org.id, agentId: fixture.twin.id, userId: f.learner.id, minutesLimit: 30, shareCode: `${fixture.org.id}-promote-twin` } });
    const roleplay = await db.rolePlayAssignment.create({ data: { orgId: fixture.org.id, deploymentId: deployment.id, memberId: fixture === f ? `${f.learner.id}-member` : `${f.learner.id}-${fixture.org.id}-member`, assignedByUserId: fixture.trainer.id, shareCode: `${fixture.org.id}-promote-rp`, expiresAt: new Date() } });
    return { twin, roleplay };
  };

  test("dropLearnerAssignments removes only this org's assignments, is repeatable, and leaves other memberships intact", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      // A person can be a learner in two orgs; cleanup must not remove the other org's access.
      await db.member.create({ data: { id: `${f.learner.id}-${other.org.id}-member`, organizationId: other.org.id, userId: f.learner.id, role: "user", createdAt: new Date() } });
      await assignments();
      const retained = await assignments(other);
      await dropLearnerAssignments(other.org.id, `${f.learner.id}-member`); // wrong org is a no-op
      expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(1);
      await dropLearnerAssignments(f.org.id, `${f.learner.id}-member`);
      await dropLearnerAssignments(f.org.id, `${f.learner.id}-member`);
      await dropLearnerAssignments(f.org.id, "missing-member");
      expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
      expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
      expect(await db.twinAssignment.findUnique({ where: { id: retained.twin.id } })).toEqual(retained.twin);
      expect(await db.rolePlayAssignment.findUnique({ where: { id: retained.roleplay.id } })).toEqual(retained.roleplay);
    } finally { await other.clean(); }
  });

  test.each(["team", "user"])("Better Auth update-member-role to %s drops studio assignments only and keeps session history", async (role) => {
    const { twin, roleplay } = await assignments();
    const pastTwin = await f.session({ agentId: f.twin.id, agentSlug: f.twin.slug, twinAssignmentId: twin.id, transcript: [{ who: "learner", text: "Twin history" }], report: { summary: "Twin report" } });
    const pastRoleplay = await f.session({ assignmentId: roleplay.id, transcript: [{ who: "learner", text: "Role-play history" }], report: { summary: "Role-play report" } });
    const signedIn = await post("sign-in/email-otp", { email: f.trainer.email, otp: await otp(f.trainer.email) });
    expect(signedIn.status).toBe(200);
    const response = await post("organization/update-member-role", { organizationId: f.org.id, memberId: `${f.learner.id}-member`, role }, cookies(signedIn));
    expect(response.status).toBe(200);
    expect(await orgPerson(f.org.id, { userId: f.learner.id })).toMatchObject({ role });
    const isLearner = role === "user";
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(isLearner ? 1 : 0);
    expect(await db.rolePlayAssignment.count({ where: { orgId: f.org.id } })).toBe(isLearner ? 1 : 0);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: pastTwin.id } })).toEqual({ ...pastTwin, twinAssignmentId: isLearner ? twin.id : null });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: pastRoleplay.id } })).toEqual({ ...pastRoleplay, assignmentId: isLearner ? roleplay.id : null });
    expect(await listTwinAssignments(f.org.id, f.twin.id)).toHaveLength(isLearner ? 1 : 0);
    const caller = roleplayRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
    expect((await caller.scenarios.list()).find((a) => a.slug === f.roleplay.slug)?.learners).toHaveLength(isLearner ? 1 : 0);
    expect((await listSpecSummaries("agents", f.org.id)).find((a) => a.slug === f.roleplay.slug)?.learners).toHaveLength(isLearner ? 1 : 0);
  });

  test.each(["admin", "team", "user"])("Better Auth invite-member refuses %s; nothing to accept", async (role) => {
    const signedIn = await post("sign-in/email-otp", { email: f.trainer.email, otp: await otp(f.trainer.email) });
    expect(signedIn.status).toBe(200);
    const response = await post("organization/invite-member", { organizationId: f.org.id, email: `invite-${f.org.id}@example.com`, role }, cookies(signedIn));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("Add people from Settings") });
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
  });
});
