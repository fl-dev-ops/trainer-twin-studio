import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { auth } from "@/lib/auth";
import { GET, POST, PATCH, PUT, DELETE, OPTIONS, OPEN_AUTH_ROUTES } from "@/app/api/auth/[...all]/route";
import * as email from "@/lib/email";
import { addPeopleToOrg, orgPerson } from "@/lib/org-people";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { changeMemberRole, setMemberDisabled } from "@/lib/members";
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

  test("development signs in with the terminal OTP through the real delivery hook, without exposing it in HTTP", async () => {
    send.mockRestore();
    const previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: "development" });
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const sent = await post("email-otp/send-verification-otp", { email: f.learner.email, type: "sign-in" });
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ success: true });
      const message = info.mock.calls.map(([value]) => String(value)).find((line) => line.startsWith(`[Dev sign-in] Code for ${f.learner.email}: `));
      const code = message?.match(/: (\d{6}) \(expires in 10 minutes\)/)?.[1];
      if (!code) throw new Error("The generated OTP was not printed to the server terminal");
      const stored = await db.verification.findFirstOrThrow({ where: { identifier: { contains: f.learner.email } } });
      expect(stored.value).not.toContain(code);
      const signedIn = await post("sign-in/email-otp", { email: f.learner.email, otp: code });
      expect(signedIn.status).toBe(200);
      expect(cookies(signedIn)).toBeTruthy();
      expect((await post("sign-in/email-otp", { email: f.learner.email, otp: code })).status).not.toBe(200);
    } finally {
      info.mockRestore();
      if (previous === undefined) delete process.env.NODE_ENV;
      else Object.assign(process.env, { NODE_ENV: previous });
    }
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

  test.each(["team", "user"])("staff changeMemberRole to %s drops studio assignments only and keeps session history", async (role) => {
    const { twin, roleplay } = await assignments();
    const pastTwin = await f.session({ agentId: f.twin.id, agentSlug: f.twin.slug, twinAssignmentId: twin.id, transcript: [{ who: "learner", text: "Twin history" }], report: { summary: "Twin report" } });
    const pastRoleplay = await f.session({ assignmentId: roleplay.id, transcript: [{ who: "learner", text: "Role-play history" }], report: { summary: "Role-play report" } });
    await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role });
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
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found.", code: "not_found" });
    expect(await db.invitation.count({ where: { organizationId: f.org.id } })).toBe(0);
  });
  const rowCounts = async () => Promise.all([
    db.user.count({ where: { email: { contains: f.org.id } } }),
    db.member.count({ where: { organizationId: f.org.id } }),
    db.session.count({ where: { userId: { in: [f.learner.id, f.trainer.id] } } }),
    db.account.count({ where: { userId: { in: [f.learner.id, f.trainer.id] } } }),
    db.verification.count({ where: { identifier: { contains: f.org.id } } }),
    db.invitation.count({ where: { organizationId: f.org.id } }),
    db.apikey.count({ where: { referenceId: f.org.id } }),
  ]);
  test("every OPEN_AUTH_ROUTES entry passes through the real route handler to Better Auth", async () => {
    const expected = ["GET /get-session", "POST /sign-out", "GET /ok", "GET /error", "POST /email-otp/send-verification-otp", "POST /sign-in/email-otp", "POST /sign-in/social", "GET /callback/google", "POST /callback/google", "POST /organization/set-active", "POST /update-user"];
    expect([...OPEN_AUTH_ROUTES].sort()).toEqual(expected.sort());
    const downstream = spyOn(auth, "handler").mockImplementation(async () => Response.json({ passedThrough: true }));
    try {
      const before = await rowCounts();
      for (const entry of OPEN_AUTH_ROUTES) {
        const [method, path] = entry.split(" ");
        const request = new Request(`https://dash.${BASE_DOMAIN}/api/auth${path}`, { method, ...(method === "POST" ? { body: JSON.stringify({ name: "Updated" }) } : {}) });
        expect(await (await (method === "GET" ? GET : POST)(request)).json()).toEqual({ passedThrough: true });
        expect(downstream.mock.calls.at(-1)?.[0]).toBe(request);
      }
      expect(downstream).toHaveBeenCalledTimes(expected.length);
      expect(await rowCounts()).toEqual(before);
    } finally { downstream.mockRestore(); }
  });
  test.each(["organization/leave", "organization/update", "organization/list-members", "organization/get-full-organization", "organization/update-member-role", "organization/add-member", "organization/invite-member", "organization/remove-member", "organization/create", "api-key/create", "api-key/list", "api-key/delete", "sign-in/email", "sign-up/email", "change-password", "email-otp/reset-password", "forget-password/email-otp"])("refuses not_found for closed Better Auth path %s with no writes", async (path) => {
    const before = await rowCounts();
    for (const method of ["GET", "POST"]) {
      const response = method === "POST" ? await post(path, { organizationId: f.org.id, userId: f.learner.id, email: f.learner.email, role: "admin" }) : await GET(new Request(`https://dash.${BASE_DOMAIN}/api/auth/${path}`));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found.", code: "not_found" });
    }
    expect(await rowCounts()).toEqual(before);
  });
  test("refuses not_found for wrong methods on every open auth path without calling Better Auth", async () => {
    const before = await rowCounts();
    const downstream = spyOn(auth, "handler");
    try {
      for (const entry of OPEN_AUTH_ROUTES) {
        const [method, path] = entry.split(" ");
        for (const wrong of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
          if (OPEN_AUTH_ROUTES.has(`${wrong} ${path}`)) continue;
          // GET/POST are the only exported handlers; these calls exercise their method allowlist too.
          const response = await (method === "GET" ? GET : POST)(new Request(`https://dash.${BASE_DOMAIN}/api/auth${path}`, { method: wrong }));
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: "Not found.", code: "not_found" });
        }
      }
      expect(downstream).not.toHaveBeenCalled();
      expect(await rowCounts()).toEqual(before);
    } finally { downstream.mockRestore(); }
  });
  test("refuses not_found through actual PATCH/PUT/DELETE/OPTIONS exports before Better Auth or writes", async () => {
    const before = await rowCounts(); const downstream = spyOn(auth, "handler");
    try {
      for (const handler of [PATCH, PUT, DELETE, OPTIONS]) {
        const response = await handler();
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found.", code: "not_found" });
      }
      expect(downstream).not.toHaveBeenCalled(); expect(await rowCounts()).toEqual(before);
    } finally { downstream.mockRestore(); }
  });
  test("leaving an org has no Better Auth hook, so no app code calls leaveOrganization (its HTTP route is closed above)", async () => {
    const { Glob } = await import("bun");
    const callers: string[] = [];
    for (const root of ["lib", "app", "workflows", "components", "scripts"]) {
      for await (const file of new Glob(`${root}/**/*.{ts,tsx}`).scan({ cwd: process.cwd() })) {
        if (file.startsWith("lib/generated/")) continue;
        if ((await Bun.file(file).text()).includes("leaveOrganization")) callers.push(file);
      }
    }
    expect(callers).toEqual([]);
  });
  test("refuses invalid_input for update-user image or name+image, but a name-only update works", async () => {
    const signedIn = await post("sign-in/email-otp", { email: f.trainer.email, otp: await otp(f.trainer.email) });
    const cookie = cookies(signedIn);
    const before = await rowCounts();
    const original = await db.user.findUniqueOrThrow({ where: { id: f.trainer.id } });
    for (const body of [{ image: "https://evil.test/picture" }, { name: "Changed", image: "https://evil.test/picture" }, {}, { name: "Changed", extra: true }]) {
      const response = await post("update-user", body, cookie);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_input", error: "Only your name can be changed here." });
      expect(await db.user.findUniqueOrThrow({ where: { id: f.trainer.id } })).toEqual(original);
      expect(await rowCounts()).toEqual(before);
    }
    expect((await post("update-user", { name: "Updated name" }, cookie)).status).toBe(200);
    expect(await db.user.findUniqueOrThrow({ where: { id: f.trainer.id } })).toMatchObject({ name: "Updated name", image: original.image });
  });
  test("refuses member_action_closed from server-side addMember/updateMemberRole/removeMember/createInvitation", async () => {
    const signedIn = await post("sign-in/email-otp", { email: f.trainer.email, otp: await otp(f.trainer.email) });
    const headers = new Headers({ cookie: cookies(signedIn) });
    const outsider = await db.user.create({ data: { id: `${f.org.id}-new-team`, email: `new-team-${f.org.id}@example.com`, name: "New team", emailVerified: true } });
    const before = await rowCounts();
    const member = await db.member.findUniqueOrThrow({ where: { id: `${f.learner.id}-member` } });
    const actions = [
      () => auth.api.addMember({ headers, body: { organizationId: f.org.id, userId: outsider.id, role: "team" } }),
      () => auth.api.updateMemberRole({ headers, body: { organizationId: f.org.id, memberId: member.id, role: "team" } }),
      () => auth.api.removeMember({ headers, body: { organizationId: f.org.id, memberIdOrEmail: member.id } }),
      () => auth.api.createInvitation({ headers, body: { organizationId: f.org.id, email: `invited-${f.org.id}@example.com`, role: "user" } }),
    ];
    for (const action of actions) {
      const error = await action().catch((error) => error);
      expect(error).toMatchObject({ status: "FORBIDDEN", statusCode: 403, body: { code: "member_action_closed", message: "Add, change and disable people from Settings." } });
      expect(await rowCounts()).toEqual(before);
      expect(await db.member.findUniqueOrThrow({ where: { id: member.id } })).toEqual(member);
    }
  });
  test("refuses member_disabled at the sign-in hook, with no login created", async () => {
    await setMemberDisabled({ orgId: f.org.id, actorUserId: f.trainer.id, memberId: `${f.learner.id}-member`, disabled: true });
    const code = await otp(f.learner.email);
    const before = await db.session.count({ where: { userId: f.learner.id } });
    const response = await post("sign-in/email-otp", { email: f.learner.email, otp: code });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "member_disabled", message: "Your access to this organization has been turned off. Ask its admin to turn it back on." });
    expect(await db.session.count({ where: { userId: f.learner.id } })).toBe(before);
  });

});
