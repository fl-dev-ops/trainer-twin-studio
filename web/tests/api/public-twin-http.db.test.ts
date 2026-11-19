import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as nextHeaders from "next/headers";
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies";
import { MutableRequestCookiesAdapter } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import * as workflow from "workflow/api";
import * as livekit from "@/lib/livekit";
import { z } from "zod";
import { POST as start } from "@/app/api/public/twins/[agentId]/sessions/route";
import { POST as end } from "@/app/api/public/sessions/[sessionId]/end/route";
import { POST as webhook } from "@/app/api/sessions/webhook/route";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { PUBLIC_VISITOR_COOKIE } from "@/lib/public-twin-request";
import { browserToken, runtimeToken } from "@/lib/interview-sessions";
import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

const openedSchema = z.object({
  session: z.object({
    id: z.string(), runtimeToken: z.string(), status: z.literal("active"), mode: z.literal("voice"), secondsLeft: z.number(),
  }),
  participantToken: z.string(),
  room: z.string(),
});

describe.skipIf(!localMinutesDb)("public twin HTTP lifecycle (real database)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let oldSecret: string | undefined;
  const secret = "public-http-secret";
  const spies: { mockRestore(): void }[] = [];
  let cookieContext: ReturnType<typeof spyOn<typeof nextHeaders, "cookies">>;
  let transport: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
  let scheduling: ReturnType<typeof spyOn<typeof workflow, "start">>;
  beforeEach(async () => {
    f = minutesFixture();
    other = minutesFixture();
    await f.create();
    await other.create();
    oldSecret = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = secret;
    const agent = await db.agent.update({
      where: { id: f.twin.id },
      data: { version: 3, data: { objective: "Pinned original twin", publicAccess: { enabled: true, maxSeconds: 120 } } },
    });
    await db.persona.update({ where: { id: agent.personaId }, data: { version: 2, data: { identity: "Pinned original persona" } } });
    await fundOrg({ orgId: f.org.id, minutes: 10 });
    cookieContext = spyOn(nextHeaders, "cookies");
    scheduling = spyOn(workflow, "start").mockResolvedValue(undefined as never);
    transport = spyOn(livekit, "activateLiveKitSession").mockImplementation(async (input) => ({
      room: input.sessionId, token: "public-participant-token", dispatchId: "public-dispatch", videoEgressId: null, videoS3Key: null,
    }));
    const realFetch = globalThis.fetch;
    spies.push(cookieContext, scheduling, transport,
      spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if (String(url).includes("meteroid.test")) return realFetch(url, init);
        if (new URL(String(url)).pathname === "/internal/sessions") return Promise.resolve(new Response(null, { status: 204 }));
        throw new Error(`Unexpected network request: ${String(url)}`);
      }));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (oldSecret === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = oldSecret;
    await f.clean();
    await other.clean();
  });
  const host = (fixture = f) => `${fixture.org.slug}.${BASE_DOMAIN}`;
  const request = (path: string, options: { fixture?: MinutesFixture; cookie?: string; token?: string; origin?: string; body?: unknown } = {}) => {
    const hostname = host(options.fixture);
    return new Request(`https://${hostname}${path}`, {
      method: "POST",
      headers: {
        host: hostname, origin: options.origin ?? `https://${hostname}`,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  };
  const invoke = async (req: Request, handler: () => Promise<Response>) => {
    const setCookies: string[] = [];
    const jar = MutableRequestCookiesAdapter.wrap(new RequestCookies(req.headers), (values) => {
      setCookies.splice(0, setCookies.length, ...values);
    });
    cookieContext.mockResolvedValue(jar);
    return { response: await handler(), setCookies, jar };
  };
  const startCall = async (options: Parameters<typeof request>[1] = {}) => {
    const req = request(`/api/public/twins/${f.twin.id}/sessions`, { body: { name: "  Visitor <admin>  " }, ...options });
    return invoke(req, () => start(req, { params: Promise.resolve({ agentId: f.twin.id }) }));
  };
  const endCall = async (id: string, options: Parameters<typeof request>[1]) => {
    const req = request(`/api/public/sessions/${id}/end`, options);
    return invoke(req, () => end(req, { params: Promise.resolve({ sessionId: id }) }));
  };
  const open = async () => {
    const result = await startCall();
    expect(result.response.status).toBe(200);
    const body: unknown = await result.response.json();
    const opened = openedSchema.parse(body);
    const value = result.jar.get(PUBLIC_VISITOR_COOKIE)?.value;
    if (!value) throw new Error("Successful start did not issue a visitor cookie");
    return { ...result, body, opened, value, cookie: `${PUBLIC_VISITOR_COOKIE}=${value}` };
  };
  const agentWebhook = (id: string, token: string, transcript = [{ role: "user", text: "Agent's authoritative final conversation" }]) => webhook(new Request("https://test/api/sessions/webhook", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: id, status: "COMPLETED", transcript }),
  }));

  test("cookie-issued start -> repeated end -> authoritative webhook charges once and never accepts browser transcript", async () => {
    const result = await open();
    const { id, runtimeToken: browser } = result.opened.session;
    expect(result.body).toMatchObject({ participantToken: "public-participant-token", room: id });
    expect(result.body).not.toHaveProperty("agentToken");
    expect(result.body).toHaveProperty("session.runtimeToken", browserToken(id));
    expect(result.body).not.toHaveProperty("session.agentToken");
    expect(JSON.stringify(result.body)).not.toContain(runtimeToken(id));
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.value).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(result.setCookies).toHaveLength(1);
    expect(result.setCookies[0]).toContain("HttpOnly");
    expect(result.setCookies[0]).toContain("SameSite=strict");
    expect(result.setCookies[0]).toContain("Path=/api/public");
    expect(result.setCookies[0]).toContain("Max-Age=2592000");
    expect(result.setCookies[0]).not.toMatch(/Domain=/i);
    expect(result.jar.get(PUBLIC_VISITOR_COOKIE)?.secure ?? false).toBe(process.env.NODE_ENV === "production");
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id } });
    const digest = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
    expect(row).toMatchObject({
      orgId: f.org.id, userId: null, anonymousName: "Visitor <admin>",
      anonymousId: digest(`visitor:${f.org.id}:${result.value}`),
      anonymousIpHash: digest(`public-ip:${f.org.id}:shared`),
      allowedSeconds: 120, agentVersion: 3, personaVersion: 2,
    });
    expect(await availableOrgSeconds(f.org.id)).toBe(480);
    expect(transport.mock.calls[0][0]).toMatchObject({ anonymous: true, userName: "Visitor <admin>", userId: `visitor-${id}`, runtimeToken: runtimeToken(id) });
    await db.interviewSession.update({ where: { id }, data: { startedAt: new Date(Date.now() - 90_000) } });
    const forged = { transcript: [{ role: "user", text: "Forged browser transcript" }], evidence: { transcriptFinal: true }, status: "completed" };
    const first = await endCall(id, { cookie: result.cookie, token: browser, body: forged });
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toEqual({ ok: true });
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    expect(first.setCookies).toEqual([]);
    const ended = await db.interviewSession.findUniqueOrThrow({ where: { id } });
    expect(ended).toMatchObject({ status: "abandoned", transcript: null, evidence: null, runtimeTokenHash: null });
    expect((await endCall(id, { cookie: result.cookie, token: browser, body: forged })).response.status).toBe(200);
    expect((await agentWebhook(id, browser)).status).toBe(401);
    const transcript = [{ role: "user", text: "Agent's authoritative final conversation" }];
    expect((await agentWebhook(id, secret, transcript)).status).toBe(200);
    expect((await agentWebhook(id, secret, transcript)).status).toBe(200);
    expect((await endCall(id, { cookie: result.cookie, token: browser, body: forged })).response.status).toBe(200);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "completed", transcript, evidence: { transcriptFinal: true }, endedAt: ended.endedAt,
    });
    const ledger = await db.minuteLedger.findMany({ where: { sessionId: id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "org_usage", userId: null, email: null, orgId: f.org.id });
    expect(ledger[0].seconds).toBeLessThanOrEqual(-89);
    expect(ledger[0].seconds).toBeGreaterThanOrEqual(-95);
    expect(await availableOrgSeconds(f.org.id)).toBe(600 + ledger[0].seconds);
  });
  test("compiled config pins the selected agent/persona content and versions across later edits", async () => {
    const result = await open();
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: result.opened.session.id } });
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.twin.id } });
    expect(row.compiledSnapshot).toMatchObject({
      persona: { id: agent.personaId, slug: f.org.id, version: 2, data: { identity: "Pinned original persona" } },
      agent: { id: f.twin.id, slug: f.twin.slug, version: 3, data: { objective: "Pinned original twin" } },
      context: null, sessionDocumentIds: [], knowledgeBases: [],
    });
    await db.persona.update({ where: { id: agent.personaId }, data: { version: 3, data: { identity: "Changed persona" } } });
    await db.agent.update({ where: { id: f.twin.id }, data: { version: 4, data: { objective: "Changed twin" } } });
    const pinned = await db.interviewSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(pinned.compiledSnapshot).toEqual(row.compiledSnapshot);
    expect(pinned).toMatchObject({ agentVersion: 3, personaVersion: 2 });
  });
  test.each(["other-org", "other-cookie", "missing-cookie", "malformed-cookie", "wrong-token", "agent-token"])("end rejects %s without changing session or issuing a cookie", async (kind) => {
    const result = await open();
    const { id, runtimeToken: browser } = result.opened.session;
    const before = await db.interviewSession.findUniqueOrThrow({ where: { id } });
    const denied = await endCall(id, {
      fixture: kind === "other-org" ? other : f,
      cookie: kind === "missing-cookie" ? undefined : kind === "other-cookie" ? `${PUBLIC_VISITOR_COOKIE}=${"x".repeat(43)}` : kind === "malformed-cookie" ? `${PUBLIC_VISITOR_COOKIE}=invalid` : result.cookie,
      token: kind === "wrong-token" ? browserToken("different-session") : kind === "agent-token" ? runtimeToken(id) : browser,
    });
    expect(denied.response.status).toBe(404);
    expect(denied.setCookies).toEqual([]);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await db.minuteLedger.count({ where: { sessionId: id } })).toBe(0);
  });
  test("same-origin request on another real org host cannot start this twin", async () => {
    const result = await startCall({ fixture: other });
    expect(result.response.status).toBe(404);
    expect(await db.interviewSession.count({ where: { orgId: { in: [f.org.id, other.org.id] } } })).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
  test("replaying the issued cookie preserves identity and cannot bypass the active-call limit", async () => {
    const result = await open();
    const replay = await startCall({ cookie: result.cookie });
    expect(replay.response.status).toBe(409);
    expect(await replay.response.json()).toMatchObject({ code: "public_call_busy" });
    expect(replay.setCookies).toEqual([]);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });
  test("malformed incoming cookie is replaced with a new server-issued identity on start", async () => {
    const result = await startCall({ cookie: `${PUBLIC_VISITOR_COOKIE}=attacker-chosen-identity` });
    expect(result.response.status).toBe(200);
    expect(result.setCookies).toHaveLength(1);
    expect(result.jar.get(PUBLIC_VISITOR_COOKIE)?.value).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(result.setCookies[0]).not.toContain("attacker-chosen-identity");
  });
  test("cross-origin start is refused before issuing identity or starting workflows", async () => {
    const result = await startCall({ origin: `https://${host(other)}` });
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject({ code: "public_origin_invalid" });
    expect(result.setCookies).toEqual([]);
    expect(scheduling).not.toHaveBeenCalled();
  });
  test.each([
    { name: " " },
    { name: "Valid", transcript: [{ role: "user", text: "Untrusted" }] },
    { name: "Valid", maxSeconds: 300 },
    { name: "x".repeat(1025) },
  ])("start rejects invalid or authority-bearing body %j", async (body) => {
    const result = await startCall({ body });
    expect(result.response.status).toBe(400);
    expect(result.setCookies).toEqual([]);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
