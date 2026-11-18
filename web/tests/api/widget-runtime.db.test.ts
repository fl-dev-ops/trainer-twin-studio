import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as workflow from "workflow/api";
import * as livekit from "@/lib/livekit";
import { z } from "zod";
import { POST as bootstrap } from "@/app/api/public/widgets/[agentId]/bootstrap/route";
import { POST as start } from "@/app/api/public/widgets/[agentId]/sessions/route";
import { POST as end } from "@/app/api/public/widgets/sessions/[sessionId]/end/route";
import { POST as webhook } from "@/app/api/sessions/webhook/route";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { browserToken, runtimeToken } from "@/lib/interview-sessions";
import { publicIpHash } from "@/lib/public-twin-request";
import { startPublicTwinSession } from "@/lib/public-twin-sessions";
import { expirePublicCall } from "@/workflows/steps/public-call-deadline";
import { readWidgetGrant, readWidgetVisitor, widgetEndToken, widgetStartGrant, WIDGET_GRANT_SECONDS } from "@/lib/widget-tokens";
import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";

const bootstrapSchema = z.object({ grant: z.string(), visitorToken: z.string() });
const openedSchema = z.object({
  session: z.object({ id: z.string(), runtimeToken: z.string(), embedToken: z.string(), status: z.literal("active"), mode: z.literal("voice") }),
  participantToken: z.string(), room: z.string(),
});

describe.skipIf(!localMinutesDb)("widget cookieless lifecycle (real database)", () => {
  let f: MinutesFixture;
  let other: MinutesFixture;
  let previous: string | undefined;
  const secret = "widget-runtime-secret";
  const parent = "https://customer.example";
  const secondParent = "https://another.example:8443";
  const spies: { mockRestore(): void }[] = [];
  let transport: ReturnType<typeof spyOn<typeof livekit, "activateLiveKitSession">>;
  let scheduling: ReturnType<typeof spyOn<typeof workflow, "start">>;
  const config = () => ({
    publicAccess: { enabled: true, maxSeconds: 120 },
    widget: { enabled: true, allowedOrigins: [parent, secondParent], welcome: "Talk to us", accentColor: "#123456" },
  });
  beforeEach(async () => {
    f = minutesFixture();
    other = minutesFixture();
    await f.create();
    await other.create();
    previous = process.env.COPILOT_SERVICE_SECRET;
    process.env.COPILOT_SERVICE_SECRET = secret;
    for (const fixture of [f, other]) {
      await db.agent.update({ where: { id: fixture.twin.id }, data: { data: config() } });
      await fundOrg({ orgId: fixture.org.id, minutes: 10 });
    }
    scheduling = spyOn(workflow, "start").mockResolvedValue(undefined as never);
    transport = spyOn(livekit, "activateLiveKitSession").mockImplementation(async (input) => ({
      room: input.sessionId, token: "widget-participant", dispatchId: "widget-dispatch", videoEgressId: null, videoS3Key: null,
    }));
    const realFetch = globalThis.fetch;
    spies.push(scheduling, transport, spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined),
      spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if (String(url).includes("meteroid.test")) return realFetch(url, init);
        if (new URL(String(url)).pathname === "/internal/sessions") return Promise.resolve(new Response(null, { status: 204 }));
        throw new Error(`Unexpected network request: ${String(url)}`);
      }));
  });
  afterEach(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    if (previous === undefined) delete process.env.COPILOT_SERVICE_SECRET;
    else process.env.COPILOT_SERVICE_SECRET = previous;
    await f.clean();
    await other.clean();
  });
  const request = (path: string, body?: unknown, token?: string, fixture = f, origin?: string) => {
    const host = `${fixture.org.slug}.${BASE_DOMAIN}`;
    return new Request(`https://${host}${path}`, {
      method: "POST", credentials: "omit",
      headers: { host, origin: origin ?? `https://${host}`, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const boot = (body: unknown = { parentOrigin: parent }, fixture = f, agentId = fixture.twin.id) =>
    bootstrap(request(`/api/public/widgets/${agentId}/bootstrap`, body, undefined, fixture), { params: Promise.resolve({ agentId }) });
  const grant = async (parentOrigin = parent) => {
    const response = await boot({ parentOrigin });
    expect(response.status).toBe(200);
    return bootstrapSchema.parse(await response.json());
  };
  const launch = (token: string, body: unknown = { name: "  Visitor <admin>  " }, fixture = f, agentId = f.twin.id) =>
    start(request(`/api/public/widgets/${agentId}/sessions`, body, token, fixture), { params: Promise.resolve({ agentId }) });
  const finish = (id: string, token: string, fixture = f) =>
    end(request(`/api/public/widgets/sessions/${id}/end`, { transcript: [{ text: "forged" }] }, token, fixture), { params: Promise.resolve({ sessionId: id }) });
  const open = async () => {
    const credentials = await grant();
    const response = await launch(credentials.grant);
    expect(response.status).toBe(200);
    return { credentials, response, body: openedSchema.parse(await response.json()) };
  };
  const refusal = async (response: Response, status: number, code: string) => {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  };
  const noStart = async () => {
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "org_usage" } })).toBe(0);
    expect(await availableOrgSeconds(f.org.id)).toBe(600);
    expect(scheduling).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  };

  test("bootstrap is cookieless/non-billable; repeat visitor retains identity without creating users", async () => {
    const before = await db.user.count({ where: { id: { in: [f.learner.id, f.trainer.id] } } });
    const response = await boot();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    const first = bootstrapSchema.parse(await response.json());
    const repeated = await boot({ parentOrigin: parent, visitorToken: first.visitorToken });
    expect(repeated.status).toBe(200);
    const second = bootstrapSchema.parse(await repeated.json());
    expect(readWidgetGrant(second.grant).visitorId).toBe(readWidgetGrant(first.grant).visitorId);
    expect(readWidgetVisitor(second.visitorToken)).toMatchObject({ orgId: f.org.id, parentOrigin: parent });
    expect(await db.user.count({ where: { id: { in: [f.learner.id, f.trainer.id] } } })).toBe(before);
    expect(await db.member.count({ where: { organizationId: f.org.id } })).toBe(2);
    await noStart();
  });

  test("a grant that expires before reservation cannot create a session or hold credits", async () => {
    const credentials = await grant();
    const scope = readWidgetGrant(credentials.grant);
    await expect(startPublicTwinSession({
      orgId: f.org.id, agentId: f.twin.id, visitorId: scope.visitorId, name: "Visitor",
      ipHash: publicIpHash(f.org.id, new Headers()), embedOrigin: parent,
      grantExpiresAt: Math.floor(Date.now() / 1000) - 1,
    })).rejects.toMatchObject({ code: "widget_token_invalid", status: 401 });
    await noStart();
  });
  test("a grant expiring while blocked on the twin row cannot reserve credits", async () => {
    const credentials = await grant();
    const scope = readWidgetGrant(credentials.grant);
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Agent" WHERE id = ${f.twin.id} FOR UPDATE`;
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(backend.pid);
      await release.promise;
    }, { timeout: 10_000 });
    const blocker = await locked.promise;
    const pending = startPublicTwinSession({
      orgId: f.org.id, agentId: f.twin.id, visitorId: scope.visitorId, name: "Visitor",
      ipHash: publicIpHash(f.org.id, new Headers()), embedOrigin: parent,
      grantExpiresAt: scope.expiresAt,
    }).then((value) => value, (error: unknown) => error);
    let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [waiting] = await db.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE ${blocker} = ANY(pg_blocking_pids(pid))`;
        if (waiting.count > 0) { blocked = true; break; }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      clock = spyOn(Date, "now").mockReturnValue(scope.expiresAt * 1000 + 1);
      release.resolve();
      await holder;
      expect(await pending).toMatchObject({ code: "widget_token_invalid", status: 401 });
      await noStart();
    } finally {
      release.resolve();
      await holder;
      await pending;
      clock?.mockRestore();
    }
  });
  test.each(["forged", "wrong-purpose", "other-org", "other-parent"])("widget_token_invalid: bootstrap %s visitor", async (kind) => {
    const first = await grant();
    const visitorToken = kind === "forged" ? `${first.visitorToken.slice(0, -1)}!` : kind === "wrong-purpose" ? first.grant : first.visitorToken;
    await refusal(await boot({ parentOrigin: kind === "other-parent" ? secondParent : parent, visitorToken }, kind === "other-org" ? other : f), 401, "widget_token_invalid");
    await noStart();
  });
  test.each(["forged", "visitor-token", "other-org", "other-agent", "expired", "missing"])("widget_token_invalid: start %s grant before reservation", async (kind) => {
    const first = await grant();
    let token = first.grant;
    if (kind === "forged") token = `${token.slice(0, -1)}!`;
    if (kind === "visitor-token") token = first.visitorToken;
    if (kind === "missing") token = "";
    if (kind === "expired") {
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() - (WIDGET_GRANT_SECONDS + 1) * 1000);
      try { token = widgetStartGrant(readWidgetGrant(first.grant)); } finally { clock.mockRestore(); }
    }
    await refusal(await launch(token, { name: "Visitor" }, kind === "other-org" ? other : f, kind === "other-agent" ? f.roleplay.id : f.twin.id), 401, "widget_token_invalid");
    await noStart();
  });
  test.each(["removed-parent", "widget-off", "public-off", "archived"])("recheck after bootstrap: %s denies before charged start", async (kind) => {
    const first = await grant();
    const data = config();
    if (kind === "removed-parent") data.widget.allowedOrigins = [secondParent];
    if (kind === "widget-off") data.widget.enabled = false;
    if (kind === "public-off") data.publicAccess.enabled = false;
    await db.agent.update({ where: { id: f.twin.id }, data: { data, ...(kind === "archived" ? { archivedAt: new Date() } : {}) } });
    await refusal(await launch(first.grant), kind === "archived" ? 404 : 403,
      kind === "archived" ? "not_found" : kind === "public-off" ? "public_twin_unavailable" : "widget_unavailable");
    await noStart();
  });
  test("cookieless start persists embedOrigin, reserves allowance, exposes no agent token; end/webhook charge once", async () => {
    const { response, body, credentials } = await open();
    const id = body.session.id;
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(JSON.stringify(body)).not.toContain(runtimeToken(id));
    expect(body).not.toHaveProperty("agentToken");
    expect(body.session).not.toHaveProperty("agentToken");
    expect(body.session.runtimeToken).toBe(browserToken(id));
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toMatchObject({
      orgId: f.org.id, userId: null, anonymousName: "Visitor <admin>", anonymousId: readWidgetGrant(credentials.grant).visitorId,
      embedOrigin: parent, allowedSeconds: 120, chargesOrg: true,
    });
    expect(await availableOrgSeconds(f.org.id)).toBe(480);
    await db.interviewSession.update({ where: { id }, data: { startedAt: new Date(Date.now() - 90_000) } });
    expect((await finish(id, body.session.embedToken)).status).toBe(200);
    expect((await finish(id, body.session.embedToken)).status).toBe(200);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "abandoned", transcript: null, runtimeTokenHash: null });
    for (let i = 0; i < 2; i++) {
      const response = await webhook(new Request("https://test/api/sessions/webhook", {
        method: "POST", headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ session_id: id, status: "COMPLETED", transcript: [{ role: "user", text: "Trusted final transcript" }] }),
      }));
      expect(response.status).toBe(200);
    }
    expect((await finish(id, body.session.embedToken)).status).toBe(200);
    const ledger = await db.minuteLedger.findMany({ where: { sessionId: id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "org_usage", userId: null, email: null });
    expect(ledger[0].seconds).toBeLessThanOrEqual(-89);
    expect(ledger[0].seconds).toBeGreaterThanOrEqual(-95);
    expect(await availableOrgSeconds(f.org.id)).toBe(600 + ledger[0].seconds);
  });
  test("expired start grant cannot start, but separate end capability remains usable after revocation", async () => {
    const { body, credentials } = await open();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + (WIDGET_GRANT_SECONDS + 1) * 1000);
    try {
      await refusal(await launch(credentials.grant), 401, "widget_token_invalid");
      await db.agent.update({ where: { id: f.twin.id }, data: { data: {} } });
      expect((await finish(body.session.id, body.session.embedToken)).status).toBe(200);
    } finally { clock.mockRestore(); }
    expect(await db.minuteLedger.count({ where: { sessionId: body.session.id } })).toBe(1);
  });
  test.each(["start-purpose", "browser-token", "agent-token", "other-org", "session", "agent", "parent", "visitor"])("end rejects %s capability without finalizing", async (kind) => {
    const { body, credentials } = await open();
    const id = body.session.id;
    const original = await db.interviewSession.findUniqueOrThrow({ where: { id } });
    let token = body.session.embedToken;
    if (kind === "start-purpose") token = credentials.grant;
    if (kind === "browser-token") token = body.session.runtimeToken;
    if (kind === "agent-token") token = runtimeToken(id);
    if (["session", "agent", "parent", "visitor"].includes(kind)) token = widgetEndToken({
      ...readWidgetGrant(credentials.grant),
      sessionId: kind === "session" ? "another-session" : id,
      agentId: kind === "agent" ? f.roleplay.id : f.twin.id,
      parentOrigin: kind === "parent" ? secondParent : parent,
      visitorId: kind === "visitor" ? "f".repeat(64) : readWidgetGrant(credentials.grant).visitorId,
    });
    const response = await finish(id, token, kind === "other-org" ? other : f);
    expect([401, 404]).toContain(response.status);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toEqual(original);
    expect(await db.minuteLedger.count({ where: { sessionId: id } })).toBe(0);
  });
  test("public_call_busy: concurrent same-grant starts create only one reserved session", async () => {
    const credentials = await grant();
    const responses = await Promise.all([launch(credentials.grant), launch(credentials.grant)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await refusal(responses.find((response) => response.status === 409)!, 409, "public_call_busy");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
    expect(await availableOrgSeconds(f.org.id)).toBe(480);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("public_call_busy: separate allowed parent origins share the same IP concurrency quota", async () => {
    await open();
    const second = await grant(secondParent);
    await refusal(await launch(second.grant), 409, "public_call_busy");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });
  test("public_call_limit: widget and public-page service share hourly IP starts across origins", async () => {
    const ipHash = publicIpHash(f.org.id, new Headers());
    for (let i = 0; i < 3; i++) {
      const opened = await startPublicTwinSession({ orgId: f.org.id, agentId: f.twin.id, visitorId: String(i).repeat(64), ipHash, name: "Public page visitor" });
      await db.interviewSession.update({ where: { id: opened.session.id }, data: { status: "failed", endedAt: new Date(), runtimeTokenHash: null } });
    }
    const credentials = await grant(secondParent);
    await refusal(await launch(credentials.grant), 429, "public_call_limit");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(3);
  });
  test("concurrent distinct widget origins cannot reserve beyond shared org budget", async () => {
    await fundOrg({ orgId: f.org.id, minutes: -8 });
    const results = await Promise.allSettled([parent, secondParent].map((embedOrigin, i) => startPublicTwinSession({
      orgId: f.org.id, agentId: f.twin.id, visitorId: String(i).repeat(64), ipHash: String(i + 2).repeat(64), name: "Concurrent visitor", embedOrigin,
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "public_twin_unavailable" } });
    expect(await availableOrgSeconds(f.org.id)).toBe(0);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });
  test("workflow scheduling failure releases reservation without connecting voice", async () => {
    const credentials = await grant();
    scheduling.mockRejectedValueOnce(new Error("isolated workflow unavailable"));
    expect((await launch(credentials.grant)).status).toBe(500);
    expect(transport).not.toHaveBeenCalled();
    expect(await availableOrgSeconds(f.org.id)).toBe(600);
    expect(await db.interviewSession.findFirstOrThrow({ where: { orgId: f.org.id } })).toMatchObject({ status: "failed", runtimeTokenHash: null });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "org_usage" } })).toBe(0);
  });
  test("a vanished browser during activation leaves no room or credit hold after its durable deadline", async () => {
    const credentials = await grant();
    const connecting = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    let roomExists = false;
    transport.mockImplementationOnce(async (input) => {
      roomExists = true;
      connecting.resolve(input.sessionId);
      await release.promise;
      return { room: input.sessionId, token: "late-participant", dispatchId: "late-dispatch", videoEgressId: null, videoS3Key: null };
    });
    spies.push(spyOn(livekit, "closeLiveKitSession").mockImplementation(async () => { roomExists = false; }));
    const pending = launch(credentials.grant);
    const id = await connecting.promise;
    expect(await availableOrgSeconds(f.org.id)).toBe(480);
    await db.interviewSession.update({ where: { id }, data: { startedAt: new Date(Date.now() - 121_000) } });
    try {
      await expirePublicCall(id);
      expect(roomExists).toBe(false);
      release.resolve();
      expect((await pending).status).not.toBe(200);
      await expirePublicCall(id);
      expect(await db.interviewSession.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "abandoned", runtimeTokenHash: null, livekitRoom: null,
      });
      const ledger = await db.minuteLedger.findMany({ where: { sessionId: id } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ type: "org_usage", seconds: -120, userId: null, email: null });
      expect(await availableOrgSeconds(f.org.id)).toBe(480);
      expect(roomExists).toBe(false);
    } finally {
      release.resolve();
      await pending;
    }
  });
  test("database rejects embedOrigin on signed-in ownership and unallowed anonymous origins", async () => {
    await expect(Promise.resolve(f.session({ agentId: f.twin.id, agentSlug: f.twin.slug, userId: f.trainer.id, embedOrigin: parent }))).rejects.toThrow("session_embed_owner_check");
    await expect(Promise.resolve(f.session({
      agentId: f.twin.id, agentSlug: f.twin.slug, userId: null, anonymousId: "a".repeat(64),
      anonymousIpHash: "b".repeat(64), anonymousName: "Visitor", embedOrigin: "https://evil.example", chargesOrg: true, allowedSeconds: 120,
    }))).rejects.toThrow("Widget sessions require an enabled twin and allowed origin");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test.each([
    { name: " " }, { name: "Visitor", parentOrigin: secondParent }, { name: "Visitor", maxSeconds: 300 },
    { name: "Visitor", visitorId: "a".repeat(64) }, { name: "Visitor", transcript: [] }, { name: "a".repeat(1025) },
  ])("invalid_input: start body cannot supply authority %j", async (body) => {
    const credentials = await grant();
    const response = await launch(credentials.grant, body);
    expect(response.status).toBe(400);
    await noStart();
  });
  test("public_origin_invalid: external parent may frame UI but cannot call APIs cross-origin", async () => {
    const req = request(`/api/public/widgets/${f.twin.id}/bootstrap`, { parentOrigin: parent }, undefined, f, parent);
    await refusal(await bootstrap(req, { params: Promise.resolve({ agentId: f.twin.id }) }), 403, "public_origin_invalid");
    await noStart();
  });
  test("public_call_busy: active widget reserves the public-page service IP concurrency slot", async () => {
    await open();
    await expect(startPublicTwinSession({
      orgId: f.org.id, agentId: f.twin.id, visitorId: "b".repeat(64), ipHash: publicIpHash(f.org.id, new Headers()), name: "Page visitor",
    })).rejects.toMatchObject({ code: "public_call_busy" });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });
  test.each(["org-hourly", "org-concurrent"])("shared quota %s applies to widgets with independent visitor/IP", async (kind) => {
    const count = kind === "org-hourly" ? 30 : 5;
    for (let i = 0; i < count; i++) await f.session({
      agentId: f.twin.id, agentSlug: f.twin.slug, userId: null,
      anonymousId: String(i).padStart(64, "0"), anonymousIpHash: String(i).padStart(64, "1"), anonymousName: "Existing visitor",
      allowedSeconds: 120, chargesOrg: true, status: kind === "org-hourly" ? "failed" : "active",
      startedAt: new Date(), endedAt: kind === "org-hourly" ? new Date() : null,
      ...(i % 2 ? { embedOrigin: secondParent } : {}),
    });
    const credentials = await grant();
    await refusal(await launch(credentials.grant), kind === "org-hourly" ? 429 : 409, kind === "org-hourly" ? "public_call_limit" : "public_call_busy");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(count);
    expect(transport).not.toHaveBeenCalled();
  });
  test("LiveKit failure releases reservation and invalidates runtime credentials", async () => {
    const credentials = await grant();
    transport.mockRejectedValueOnce(new Error("isolated LiveKit unavailable"));
    expect((await launch(credentials.grant)).status).toBe(500);
    expect(await availableOrgSeconds(f.org.id)).toBe(600);
    expect(await db.interviewSession.findFirstOrThrow({ where: { orgId: f.org.id } })).toMatchObject({ status: "failed", runtimeTokenHash: null });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id, type: "org_usage" } })).toBe(0);
  });
});
