import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { encryptToken } from "@shared/youtube/tokens.server";

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
const { GET: session } = await import("@/app/api/connectors/google-drive/session/route");
const { POST: start } = await import("@/app/api/connectors/google-drive/oauth/start/route");
const { GET: callback } = await import("@/app/api/connectors/google-drive/oauth/callback/route");
const { startDriveOAuth, DRIVE_SCOPE } = await import("@/lib/google-drive");
const key = Buffer.alloc(32, 9).toString("base64");
const env = {
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
