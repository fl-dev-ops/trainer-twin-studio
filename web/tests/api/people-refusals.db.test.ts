import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import * as nextHeaders from "next/headers";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import * as org from "@/lib/org";
import * as sessionUser from "@/lib/session-user";
mock.module("server-only", () => ({}));
const { pageRouter } = await import("@/lib/pages/router");
import { createTrpcContext } from "@/lib/trpc";
import { addPeopleToOrg, orgPerson } from "@/lib/org-people";
import { changeMemberRole, setMemberDisabled } from "@/lib/members";
import { requireExternalApi } from "@/lib/external-api";
import { PATCH as settings } from "@/app/api/org/settings/route";
import { GET as sessionDetail } from "@/app/api/sessions/[id]/route";
import { GET as audio } from "@/app/api/sessions/[id]/audio/route";
import { GET as video } from "@/app/api/sessions/[id]/video/route";
import { POST as addUser } from "@/app/api/v1/users/route";
import { fundOrg } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

// Real guards, services, routes and PostgreSQL; only the request context and key-verification boundary are faked.
describe.skipIf(!localMinutesDb)("Module 1 refusal contract and access flows", () => {
  let f: MinutesFixture;
  let requestHeaders: Headers;
  let session: ReturnType<typeof spyOn<typeof auth.api, "getSession">>;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    requestHeaders = new Headers({ host: "dash.trainertwin.com" });
    spies.push(spyOn(nextHeaders, "headers").mockImplementation(async () => requestHeaders));
    session = spyOn(auth.api, "getSession").mockResolvedValue({ user: f.trainer, session: { activeOrganizationId: f.org.id } } as never);
    spies.push(session);
  });
  afterEach(async () => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); await f.clean(); });
  const asLearner = () => session.mockResolvedValue({ user: f.learner, session: { activeOrganizationId: f.org.id } } as never);
  const rows = () => Promise.all([
    db.organization.count({ where: { id: f.org.id } }), db.member.count({ where: { organizationId: f.org.id } }),
    db.user.count({ where: { email: { contains: f.org.id } } }), db.minuteLedger.count({ where: { orgId: f.org.id } }),
    db.twinAssignment.count({ where: { orgId: f.org.id } }), db.rolePlayAssignment.count({ where: { orgId: f.org.id } }),
    db.interviewSession.count({ where: { orgId: f.org.id } }),
  ]);
  const refusal = async (response: Response, status: number, code: string, message: string) => {
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: message, code });
  };
  const body = (patch: Record<string, unknown> = {}) => ({ name: "New name", logo: null, accentColor: "#EC3013", websiteUrl: "https://example.com", ...patch });
  const patch = (value: unknown = body()) => settings(new Request("https://dash.test/api/org/settings", { method: "PATCH", body: JSON.stringify(value) }));
  const trpc = async (path = "overview", input?: unknown) => fetchRequestHandler({
    endpoint: "/trpc", req: new Request(`https://dash.test/trpc/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`}`),
    router: pageRouter, createContext: () => createTrpcContext({ req: new Request("https://dash.test/trpc", { headers: requestHeaders }) }),
  });
  const trpcRefusal = async (response: Response, status: number, refusalCode: string, trpcCode: string, message: string) => {
    expect(response.status).toBe(status);
    const error = (await response.json()).error.json;
    expect(error.message).toBe(message);
    expect(error.data).toMatchObject({ httpStatus: status, code: trpcCode, refusal: refusalCode });
  };
  test("refuses signed_out on routes and serialized page-loader tRPC with no writes", async () => {
    session.mockResolvedValue(null); const before = await rows();
    await refusal(await patch(), 401, "signed_out", "Sign in first.");
    await trpcRefusal(await trpc(), 401, "signed_out", "UNAUTHORIZED", "Sign in first.");
    expect(await rows()).toEqual(before);
  });
  test("refuses no_org on routes and serialized page-loader tRPC with no writes", async () => {
    session.mockResolvedValue({ user: { ...f.trainer, id: "unknown" }, session: {} } as never); const before = await rows();
    await refusal(await patch(), 403, "no_org", "You're not a member of this organization.");
    await trpcRefusal(await trpc(), 403, "no_org", "FORBIDDEN", "You're not a member of this organization.");
    expect(await rows()).toEqual(before);
  });
  test("refuses studio_only on settings, knowledge, voices and every newly studio-only page loader", async () => {
    asLearner(); const before = await rows();
    const message = "Only the organization's admin and team can do this.";
    await refusal(await patch(), 403, "studio_only", message);
    const { GET: knowledge } = await import("@/app/api/knowledge/[[...kb]]/route");
    const { GET: voices } = await import("@/app/api/tts/voices/route");
    await refusal(await knowledge(new Request("https://dash.test/api/knowledge"), { params: Promise.resolve({ kb: [] }) }), 403, "studio_only", message);
    await refusal(await voices(), 403, "studio_only", message);
    for (const path of ["twinKnowledge", "talk", "overview", "voices", "developer"]) await trpcRefusal(await trpc(path, path === "talk" ? {} : undefined), 403, "studio_only", "FORBIDDEN", message);
    expect(await rows()).toEqual(before);
  });
  test("learner settings exposes only their account, not org branding/team/billing", async () => {
    asLearner();
    const result = await pageRouter.createCaller(await createTrpcContext({ req: new Request("https://dash.test") })).settings();
    expect(result).toEqual({ user: f.learner, organization: null, team: null });
  });
  test("refuses org_pin_invalid on routes and serialized tRPC instead of silently changing orgs", async () => {
    requestHeaders.set("x-trainertwin-org", "gone-org"); const before = await rows();
    const message = "This tab's organization is no longer available to you. Reload the page.";
    await refusal(await patch(), 403, "org_pin_invalid", message);
    await trpcRefusal(await trpc(), 403, "org_pin_invalid", "FORBIDDEN", message);
    expect(await rows()).toEqual(before);
  });
  test("refuses member_disabled for a pinned disabled org despite enabled studio access elsewhere", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      await db.member.create({ data: { id: `${f.learner.id}-other`, userId: f.learner.id, organizationId: other.org.id, role: "team", createdAt: new Date() } });
      await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
      asLearner(); requestHeaders.set("x-trainertwin-org", f.org.id); const before = await rows();
      const message = "Your access to this organization has been turned off. Ask its admin to turn it back on.";
      await refusal(await patch(), 403, "member_disabled", message);
      await trpcRefusal(await trpc(), 403, "member_disabled", "FORBIDDEN", message);
      expect(await rows()).toEqual(before);
      requestHeaders.delete("x-trainertwin-org"); expect((await org.studioOrg()).id).toBe(other.org.id);
    } finally { await other.clean(); }
  });
  test("without a pin or active org the oldest enabled studio membership wins", async () => {
    const other = minutesFixture();
    try {
      await other.create();
      await db.member.create({ data: { id: `${f.trainer.id}-other`, userId: f.trainer.id, organizationId: other.org.id, role: "team", createdAt: new Date(Date.now() + 60_000) } });
      session.mockResolvedValue({ user: f.trainer, session: { activeOrganizationId: "missing" } } as never);
      expect((await org.studioOrg()).id).toBe(f.org.id);
    } finally { await other.clean(); }
  });
  test("cached login after full disable cannot enter studio or access recordings; re-enable restores only membership", async () => {
    await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    const call = await f.session({ s3AudioKey: "recording.wav" });
    asLearner();
    await setMemberDisabled({ orgId: f.org.id, actorUserId: f.trainer.id, memberId: `${f.learner.id}-member`, disabled: true });
    expect(await auth.api.getSession({ headers: requestHeaders })).not.toBeNull(); // cached identity is deliberately still present
    await expect(org.studioOrg()).rejects.toBeInstanceOf(AppError);
    const identity = spyOn(sessionUser, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/auth/sign-in" }); spies.push(identity);
    await refusal(await audio(new Request("https://dash.test"), { params: Promise.resolve({ id: call.id }) }), 404, "not_found", "Not found.");
    await setMemberDisabled({ orgId: f.org.id, actorUserId: f.trainer.id, memberId: `${f.learner.id}-member`, disabled: false });
    expect((await org.studioOrg()).id).toBe(f.org.id);
    expect(await db.twinAssignment.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test.each(["route", "tRPC"])("refuses member_disabled on disabled-person studio %s despite a cached login", async (layer) => {
    asLearner(); await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } }); const before = await rows();
    const message = "Your access to this organization has been turned off. Ask its admin to turn it back on.";
    if (layer === "route") await refusal(await patch(), 403, "member_disabled", message);
    else await trpcRefusal(await trpc(), 403, "member_disabled", "FORBIDDEN", message);
    expect(await rows()).toEqual(before);
  });
  test.each([
    [{ name: " " }, "Enter an organization name."], [{ name: "x".repeat(81) }, "Use an organization name up to 80 characters."],
    [{ accentColor: "red" }, "Choose an accent colour like #EC3013."], [{ websiteUrl: "http://example.com" }, "Enter a valid HTTPS website URL."],
    [{ websiteUrl: "x".repeat(2049) }, "Enter a website URL up to 2048 characters."], [{ logo: 123 }, "Invalid input: expected string, received number"],
  ])("refuses invalid_input with the exact settings field message (%j)", async (invalid, message) => {
    const before = await rows(); const original = await db.organization.findUniqueOrThrow({ where: { id: f.org.id } });
    await refusal(await patch(body(invalid as Record<string, unknown>)), 400, "invalid_input", message as string);
    expect(await rows()).toEqual(before); expect(await db.organization.findUniqueOrThrow({ where: { id: f.org.id } })).toEqual(original);
  });
  test.each(["", "data:image/gif;base64,R0lG", "data:image/png;base64,PGh0bWw+", "data:image/jpeg;base64,PGh0bWw+", "data:image/webp;base64,PGh0bWw+", `data:image/png;base64,${Buffer.alloc(1_000_001).toString("base64")}`])("refuses logo_invalid for unsupported or oversized logos without writes", async (logo) => {
    const before = await rows(); const original = await db.organization.findUniqueOrThrow({ where: { id: f.org.id } });
    await expect(org.updateOrgSettings(f.org.id, { ...body(), logo } as never)).rejects.toMatchObject({ code: "logo_invalid", status: 400, message: "Use a PNG, JPEG or WebP logo up to 1 MB." });
    await refusal(await patch(body({ logo })), 400, "logo_invalid", "Use a PNG, JPEG or WebP logo up to 1 MB.");
    expect(await rows()).toEqual(before); expect(await db.organization.findUniqueOrThrow({ where: { id: f.org.id } })).toEqual(original);
  });
  test("settings saves all four fields atomically, keeps staff metadata and subdomain, and accepts boundary-size logos", async () => {
    await db.organization.update({ where: { id: f.org.id }, data: { metadata: JSON.stringify({ hideRoleplay: true, staffFlag: "kept", accentColor: "#000" }) } });
    const bytes = Buffer.alloc(1_000_000);
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPAAAAABJRU5ErkJggg==", "base64").copy(bytes);
    const logo = `data:image/png;base64,${bytes.toString("base64")}`;
    expect((await patch(body({ logo, accentColor: "#abc", websiteUrl: "" }))).status).toBe(200);
    const saved = await db.organization.findUniqueOrThrow({ where: { id: f.org.id } });
    expect(saved).toMatchObject({ name: "New name", logo, websiteUrl: null, slug: f.org.slug });
    expect(JSON.parse(saved.metadata!)).toEqual({ hideRoleplay: true, staffFlag: "kept", accentColor: "#abc" });
    const before = saved;
    expect((await patch(body({ slug: "changed", hideRoleplay: false }))).status).toBe(400);
    expect(await db.organization.findUniqueOrThrow({ where: { id: f.org.id } })).toEqual(before);
  });
  test("refuses invalid_input on serialized tRPC schema errors with data.refusal", async () => {
    const before = await rows(); const response = await trpc("session", { id: "" });
    expect(response.status).toBe(400);
    const error = (await response.json()).error.json;
    expect(error.data).toMatchObject({ code: "BAD_REQUEST", refusal: "invalid_input", httpStatus: 400 });
    expect(JSON.parse(error.message)).toEqual([{ origin: "string", code: "too_small", minimum: 1, inclusive: true, path: ["id"], message: "Too small: expected string to have >=1 characters" }]);
    expect(await rows()).toEqual(before);
  });
  test("refuses invalid_email in a mixed batch before any account/member/grant writes", async () => {
    const before = await rows();
    await expect(addPeopleToOrg({ orgId: f.org.id, emails: [`new-${f.org.id}@example.com`, "bad"], role: "user" })).rejects.toMatchObject({ status: 400, code: "invalid_email", message: "Not a valid email: bad" });
    expect(await rows()).toEqual(before);
  });
  test("refuses person_disabled in a mixed batch with no writes", async () => {
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } }); const before = await rows();
    await expect(addPeopleToOrg({ orgId: f.org.id, emails: [`new-${f.org.id}@example.com`, f.learner.email], role: "user" })).rejects.toMatchObject({ status: 409, code: "person_disabled", message: `${f.learner.email} is disabled in this organization. Re-enable them first.` });
    expect(await rows()).toEqual(before);
  });
  test("refuses person_is_studio for admin and team with no writes", async () => {
    await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    const before = await rows();
    for (const person of [f.trainer, f.learner]) {
      await expect(addPeopleToOrg({ orgId: f.org.id, emails: [`new-${f.org.id}@example.com`, person.email], role: "user" })).rejects.toMatchObject({ status: 409, code: "person_is_studio", message: `${person.email} is on the team. Team members practise with the organization's credits, not as learners.` });
      expect(await rows()).toEqual(before);
    }
  });
  test("refuses one_admin on a second admin with no writes", async () => {
    const before = await rows();
    await expect(addPeopleToOrg({ orgId: f.org.id, emails: [`boss-${f.org.id}@example.com`], role: "admin" })).rejects.toMatchObject({ status: 409, code: "one_admin", message: "This organization already has an admin. Add people as team or learner." });
    expect(await rows()).toEqual(before);
  });
  test.each(["missing", "disabled", "learner"])("refuses api_key_owner_gone for a %s creator with no writes", async (kind) => {
    if (kind === "disabled") await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { disabledAt: new Date() } });
    const before = await rows();
    spies.push(spyOn(auth.api, "verifyApiKey").mockResolvedValue({ valid: true, key: { id: "key", referenceId: f.org.id, metadata: kind === "missing" ? null : { createdByUserId: kind === "learner" ? f.learner.id : f.trainer.id } } } as never));
    await expect(requireExternalApi(new Request("https://dash.test", { headers: { "x-api-key": "key" } }), "users", "read")).rejects.toMatchObject({ status: 403, code: "api_key_owner_gone", message: "This API key's owner is no longer on the team. Create a new key." });
    expect(await rows()).toEqual(before);
  });
  const apiRequest = (email: string) => new Request("https://dash.test/api/v1/users", { method: "POST", headers: { "x-api-key": "key" }, body: JSON.stringify({ email }) });
  const key = () => spies.push(spyOn(auth.api, "verifyApiKey").mockResolvedValue({ valid: true, key: { id: "key", referenceId: f.org.id, metadata: { createdByUserId: f.trainer.id } } } as never));
  test("REST preserves person_disabled 409, person_is_studio 409, paused minutes 403 and short credits 409", async () => {
    key(); await fundOrg({ orgId: f.org.id, minutes: 29 });
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } }); const before = await rows();
    await refusal(await addUser(apiRequest(f.learner.email)), 409, "person_disabled", `${f.learner.email} is disabled in this organization. Re-enable them first.`);
    await refusal(await addUser(apiRequest(f.trainer.email)), 409, "person_is_studio", `${f.trainer.email} is on the team. Team members practise with the organization's credits, not as learners.`);
    await refusal(await addUser(apiRequest(`short-${f.org.id}@example.com`)), 409, "minutes", "Not enough credits in your organization's balance: 1 new person needs 30 min, 29 min left. Ask TrainerTwin to top it up.");
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: `paid-${f.org.id}`, pausedAt: new Date() } });
    await refusal(await addUser(apiRequest(`paused-${f.org.id}@example.com`)), 403, "minutes", "Your organization's plan is paused because an invoice is overdue. Pay it to continue (Settings › Billing).");
    expect(await rows()).toEqual(before);
  });
  test("refuses invalid_input for REST email schema failures with the exact field message", async () => {
    key(); const before = await rows();
    await refusal(await addUser(apiRequest("bad")), 400, "invalid_input", "A valid email is required");
    expect(await rows()).toEqual(before);
  });
  test("refuses not_found for disabled members, other learners' sessions and deleted audio/video", async () => {
    const other = await db.user.create({ data: { id: `${f.org.id}-other`, email: `other-${f.org.id}@example.com`, name: "Other learner", emailVerified: true } });
    await db.member.create({ data: { id: `${other.id}-member`, organizationId: f.org.id, userId: other.id, role: "user", createdAt: new Date() } });
    const call = await f.session({ s3AudioKey: "recording.wav", evidence: { videoS3Key: "video.mp4" } });
    const identity = spyOn(sessionUser, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.trainer, signInUrl: "/auth/sign-in" }); spies.push(identity);
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { disabledAt: new Date() } }); const before = await rows();
    for (const get of [audio, video]) await refusal(await get(new Request("https://dash.test"), { params: Promise.resolve({ id: call.id }) }), 404, "not_found", "Not found.");
    await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { disabledAt: null } });
    identity.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: other, signInUrl: "/auth/sign-in" });
    for (const get of [audio, video]) await refusal(await get(new Request("https://dash.test"), { params: Promise.resolve({ id: call.id }) }), 404, "not_found", "Not found.");
    identity.mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/auth/sign-in" });
    await db.interviewSession.update({ where: { id: call.id }, data: { deletedAt: new Date() } });
    for (const get of [audio, video]) await refusal(await get(new Request("https://dash.test"), { params: Promise.resolve({ id: call.id }) }), 404, "not_found", "Not found.");
    expect(await rows()).toEqual(before);
  });
  test.each(["admin", "team"])("enabled %s API-key creator is the actor, never an arbitrary fallback admin", async (role) => {
    if (role === "team") await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    const actor = role === "admin" ? f.trainer : f.learner;
    spies.push(spyOn(auth.api, "verifyApiKey").mockResolvedValue({ valid: true, key: { id: "owned-key", referenceId: f.org.id, metadata: { createdByUserId: actor.id } } } as never));
    const before = await rows();
    expect(await requireExternalApi(new Request("https://dash.test", { headers: { "x-api-key": "owned-key" } }), "users", "read")).toMatchObject({ actorUserId: actor.id, trainer: { userId: actor.id, role }, keyId: "owned-key", org: { id: f.org.id } });
    expect(await rows()).toEqual(before);
  });
  test("refuses api_key_owner_gone after the actual creator is removed, without falling back to the admin", async () => {
    await changeMemberRole({ orgId: f.org.id, email: f.learner.email, role: "team" });
    spies.push(spyOn(auth.api, "verifyApiKey").mockResolvedValue({ valid: true, key: { id: "owned-key", referenceId: f.org.id, metadata: { createdByUserId: f.learner.id } } } as never));
    await db.member.delete({ where: { id: `${f.learner.id}-member` } }); const before = await rows();
    await expect(requireExternalApi(new Request("https://dash.test", { headers: { "x-api-key": "owned-key" } }), "users", "read")).rejects.toMatchObject({ status: 403, code: "api_key_owner_gone", message: "This API key's owner is no longer on the team. Create a new key." });
    expect(await rows()).toEqual(before);
  });
  test("refuses not_found with the exact shared message in a page-loader tRPC", async () => {
    const before = await rows();
    await trpcRefusal(await trpc("calibrationAgent", { slug: "missing" }), 404, "not_found", "NOT_FOUND", "Not found.");
    expect(await rows()).toEqual(before);
  });
  test("refuses not_found with the shared code/message on session detail", async () => {
    spies.push(spyOn(sessionUser, "resolveSessionUser").mockResolvedValue({ org: { ...f.org, accentColor: null }, user: f.learner, signInUrl: "/auth/sign-in" }));
    const before = await rows();
    await refusal(await sessionDetail(new Request("https://dash.test"), { params: Promise.resolve({ id: "missing" }) }), 404, "not_found", "Not found.");
    expect(await rows()).toEqual(before);
  });
});
