import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { encryptToken } from "@shared/youtube/tokens.server";
import { BASE_DOMAIN } from "@/lib/base-domain";

const originalFetch = globalThis.fetch;
let actor: { id: string; user: { id: string } } | null;
let existing = false;
let uploadFailure = false;
const imported: { orgId: string; file: File }[] = [];
const queries: unknown[] = [];
const updates: unknown[] = [];
mock.module("@/lib/org", () => ({ getTrainerOrg: async () => actor }));
mock.module("@/lib/db", () => ({ db: { knowledgeDocument: {
  findFirst: async (query: unknown) => { queries.push(query); return existing ? { id: "already-imported" } : null; },
  update: async (query: unknown) => { updates.push(query); },
} } }));
mock.module("@/lib/org-knowledge", () => ({ OrganizationKnowledgeService: {
  uploadDocument: async (orgId: string, file: File) => {
    if (uploadFailure) throw new Error("Storage failed");
    imported.push({ orgId, file });
    return { id: "new-doc", status: "uploaded" };
  },
} }));
const { POST } = await import("@/app/api/connectors/google-drive/import/route");
const { GET: session, DELETE: forget } = await import("@/app/api/connectors/google-drive/session/route");
const { POST: start } = await import("@/app/api/connectors/google-drive/oauth/start/route");
const { GET: callback } = await import("@/app/api/connectors/google-drive/oauth/callback/route");
const { GET: localCallback } = await import("@/app/api/connectors/google-drive/oauth/local-callback/route");
const { startDriveOAuth, DRIVE_SCOPE } = await import("@/lib/google-drive");
const key = Buffer.alloc(32, 9).toString("base64");
const env = {
  NODE_ENV: "test",
  GOOGLE_DRIVE_CLIENT_ID: "drive-client", GOOGLE_DRIVE_CLIENT_SECRET: "drive-secret", GOOGLE_DRIVE_PICKER_API_KEY: "picker-key",
  GOOGLE_DRIVE_PROJECT_NUMBER: "12345", GOOGLE_DRIVE_REDIRECT_URI: "https://dash.test/api/connectors/google-drive/oauth/callback", GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY: key,
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
const cookie = (org = "org-1", user = "user-1") => encryptToken(JSON.stringify({ accessToken: "token", expires: Date.now() + 300_000 }), key, `${org}:${user}:google-drive:access`);
const request = (body: unknown = { fileId: "file-1" }, token = cookie(), origin = "https://dash.test") => new NextRequest("https://dash.test/api/connectors/google-drive/import", {
  method: "POST", headers: { origin, "content-type": "application/json", cookie: `tt_drive_access=${token}` }, body: JSON.stringify(body),
});
beforeEach(() => {
  Object.assign(process.env, env);
  actor = { id: "org-1", user: { id: "user-1" } };
  existing = false; uploadFailure = false; imported.length = queries.length = updates.length = 0;
  globalThis.fetch = (async (input) => new URL(String(input)).searchParams.get("alt") === "media" ? new Response("Raw document") : Response.json({ id: "file-1", name: "notes.txt", mimeType: "text/plain", size: "12" })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test("only studio users with their own org-bound cookie may import", async () => {
  actor = null;
  expect((await POST(request())).status).toBe(401);
  actor = { id: "org-1", user: { id: "user-1" } };
  expect((await POST(request(undefined, cookie("other-org")))).status).toBe(401);
  expect((await POST(request(undefined, cookie("org-1", "other-user")))).status).toBe(401);
  expect((await POST(request(undefined, ""))).status).toBe(401);
  expect((await POST(request(undefined, cookie(), "https://evil.test"))).status).toBe(403);
  expect(imported).toHaveLength(0);
});

test("proxy-rewritten requests work for connect, import and forgetting access without trusting forwarded headers", async () => {
  const headers = { host: "dash.test", origin: "https://dash.test", cookie: `tt_drive_access=${cookie()}` };
  const base = "https://localhost:3000/api/connectors/google-drive";
  const connected = await start(new Request(`${base}/oauth/start`, { method: "POST", headers }));
  expect(connected.status).toBe(200);
  expect(connected.headers.get("set-cookie")).toContain("Secure");
  const imported = await POST(new NextRequest(`${base}/import`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ fileId: "file-1" }),
  }));
  expect(imported.status).toBe(201);
  expect((await forget(new NextRequest(`${base}/session`, { method: "DELETE", headers }))).status).toBe(200);
  expect((await start(new Request(`${base}/oauth/start`, { method: "POST", headers: { ...headers, origin: "https://evil.test" } }))).status).toBe(403);
});

test("validates IDs and ignores no caller-provided download URLs or metadata", async () => {
  expect((await POST(request({ fileId: "https://evil.test" }))).status).toBe(400);
  expect((await POST(request({ fileId: "file-1", url: "https://evil.test" }))).status).toBe(400);
  expect(imported).toHaveLength(0);
});

test("imports through the existing two-copy upload service and saves Drive provenance", async () => {
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ ok: true, status: "uploaded", documentId: "new-doc" });
  expect(imported[0].orgId).toBe("org-1");
  expect(imported[0].file.name).toBe("notes.txt");
  expect(await imported[0].file.text()).toBe("Raw document");
  expect(updates).toEqual([{ where: { id: "new-doc" }, data: { externalId: "google-drive:file-1" } }]);
  expect(queries[0]).toMatchObject({ where: { kb: { orgId: "org-1" }, externalId: "google-drive:file-1", status: "uploaded" } });
});

test("repeat imports return the existing org document without creating another", async () => {
  existing = true;
  expect(await (await POST(request())).json()).toMatchObject({ alreadyImported: true, documentId: "already-imported" });
  expect(imported).toHaveLength(0);
});

test("disabled Drive API is reported as setup failure before any file is stored", async () => {
  globalThis.fetch = (async () => Response.json({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 })) as typeof fetch;
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("Enable Google Drive API");
  expect(imported).toHaveLength(0);
  expect(updates).toHaveLength(0);
});

test("a failed storage call stays a failure, with no provenance marked as saved", async () => {
  uploadFailure = true;
  expect((await POST(request())).status).toBe(500);
  expect(updates).toHaveLength(0);
});

test("picker token response is private, uncached and contains no client secret", async () => {
  const response = await session(new NextRequest("https://dash.test/api/connectors/google-drive/session", { headers: { cookie: `tt_drive_access=${cookie()}` } }));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ accessToken: "token", apiKey: "picker-key", appId: "12345" });
});

test("OAuth start sets an HttpOnly cookie and refuses cross-origin requests", async () => {
  const response = await start(new Request("https://dash.test/api/connectors/google-drive/oauth/start", { method: "POST", headers: { origin: "https://dash.test" } }));
  const saved = response.headers.get("set-cookie")!;
  expect(saved).toContain("HttpOnly"); expect(saved).toContain("Secure"); expect(saved).toContain("Path=/api/connectors/google-drive");
  const data = await response.json();
  expect(data.url).not.toContain("drive-secret");
  expect((await start(new Request("https://dash.test/api/connectors/google-drive/oauth/start", { method: "POST", headers: { origin: "https://evil.test" } }))).status).toBe(403);
});

test("local bridge forwards only code/state to the fixed studio, then the normal callback validates and exchanges", async () => {
  const redirect = "http://localhost:3000/api/connectors/google-drive/oauth/local-callback";
  process.env.GOOGLE_DRIVE_REDIRECT_URI = redirect;
  const flow = startDriveOAuth(actor!);
  const state = new URL(flow.url).searchParams.get("state")!;
  const bridge = await localCallback(new NextRequest(`${redirect}?code=one-use-code&state=${state}&redirect_uri=https://evil.test&access_token=ignored`));
  expect(bridge.status).toBe(303);
  expect(bridge.headers.get("Cache-Control")).toBe("no-store");
  expect(bridge.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(bridge.headers.get("set-cookie")).toBeNull();
  const target = new URL(bridge.headers.get("location")!);
  expect(target.origin).toBe(`https://dash.${BASE_DOMAIN}`);
  expect(target.pathname).toBe("/api/connectors/google-drive/oauth/callback");
  expect([...target.searchParams.keys()].sort()).toEqual(["code", "state"]);
  let exchanges = 0;
  globalThis.fetch = (async (_input, init) => {
    exchanges++;
    expect((init!.body as URLSearchParams).get("redirect_uri")).toBe(redirect);
    return Response.json({ access_token: "local-access-token", expires_in: 3600, scope: DRIVE_SCOPE });
  }) as typeof fetch;
  const response = await callback(new NextRequest(target, { headers: { cookie: `tt_drive_oauth=${flow.cookie}` } }));
  expect(exchanges).toBe(1);
  expect(response.headers.get("location")).toBe(`https://dash.${BASE_DOMAIN}/twin/knowledge?drive=connected`);
  const saved = response.headers.get("set-cookie")!;
  expect(saved).toContain("tt_drive_access=");
  expect(saved).toContain("Secure");
  expect(saved).not.toContain("local-access-token");
});

test("local bridge forwards cancellation, but the normal callback still needs the original state cookie", async () => {
  const redirect = "http://localhost:3000/api/connectors/google-drive/oauth/local-callback";
  process.env.GOOGLE_DRIVE_REDIRECT_URI = redirect;
  const flow = startDriveOAuth(actor!);
  const state = new URL(flow.url).searchParams.get("state")!;
  const bridge = await localCallback(new NextRequest(`${redirect}?error=access_denied&state=${state}`));
  const target = new URL(bridge.headers.get("location")!);
  expect(target.searchParams.get("error")).toBe("access_denied");
  const cancelled = await callback(new NextRequest(target, { headers: { cookie: `tt_drive_oauth=${flow.cookie}` } }));
  expect(new URL(cancelled.headers.get("location")!).searchParams.get("error")).toMatch(/cancelled/);
  target.searchParams.delete("error"); target.searchParams.set("code", "one-use-code");
  let exchanges = 0;
  globalThis.fetch = (async () => { exchanges++; throw new Error("Must not exchange without the original cookie"); }) as typeof fetch;
  const missing = await callback(new NextRequest(target));
  expect(new URL(missing.headers.get("location")!).searchParams.has("error")).toBe(true);
  expect(missing.headers.get("set-cookie")).not.toContain("tt_drive_access=");
  actor = { id: "other-org", user: { id: "user-1" } };
  const crossOrg = await callback(new NextRequest(target, { headers: { cookie: `tt_drive_oauth=${flow.cookie}` } }));
  expect(new URL(crossOrg.headers.get("location")!).searchParams.has("error")).toBe(true);
  expect(exchanges).toBe(0);
});

test("local bridge refuses production, other origins, malformed params and production callback configurations", async () => {
  const redirect = "http://localhost:3000/api/connectors/google-drive/oauth/local-callback";
  process.env.GOOGLE_DRIVE_REDIRECT_URI = redirect;
  expect((await localCallback(new NextRequest(redirect))).status).toBe(400);
  expect((await localCallback(new NextRequest(`${redirect}?state=x&code=a&error=denied`))).status).toBe(400);
  expect((await localCallback(new NextRequest(`https://evil.test/api/connectors/google-drive/oauth/local-callback?state=x&code=a`))).status).toBe(404);
  process.env.NODE_ENV = "production";
  expect((await localCallback(new NextRequest(`${redirect}?state=x&code=a`))).status).toBe(404);
  process.env.NODE_ENV = "test";
  process.env.GOOGLE_DRIVE_REDIRECT_URI = env.GOOGLE_DRIVE_REDIRECT_URI;
  expect((await localCallback(new NextRequest(`${redirect}?state=x&code=a`))).status).toBe(404);
});

test("OAuth callback clears state, stores access privately and returns to the Drive import panel", async () => {
  const flow = startDriveOAuth(actor!);
  const state = new URL(flow.url).searchParams.get("state")!;
  globalThis.fetch = (async () => Response.json({ access_token: "secret-access-token", expires_in: 3600, scope: DRIVE_SCOPE })) as typeof fetch;
  const response = await callback(new NextRequest(`https://dash.test/api/connectors/google-drive/oauth/callback?code=one-use-code&state=${state}`, { headers: { cookie: `tt_drive_oauth=${flow.cookie}` } }));
  expect(response.headers.get("location")).toBe("https://dash.test/twin/knowledge?drive=connected");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const saved = response.headers.get("set-cookie")!;
  expect(saved).toContain("tt_drive_oauth=;"); expect(saved).toContain("Max-Age=0"); expect(saved).toContain("tt_drive_access=");
  expect(saved).not.toContain("secret-access-token");
});
