import { afterEach, beforeEach, expect, test } from "bun:test";
import { decryptToken, encryptToken } from "@shared/youtube/tokens.server";
import { assertDriveOrigin, downloadDriveFile, driveAccess, driveConfig, DRIVE_SCOPE, finishDriveOAuth, startDriveOAuth } from "@/lib/google-drive";

const actor = { id: "org-1", user: { id: "user-1" } };
const realFetch = globalThis.fetch;
const env = {
  GOOGLE_DRIVE_CLIENT_ID: "drive-client",
  GOOGLE_DRIVE_CLIENT_SECRET: "drive-secret",
  GOOGLE_DRIVE_PICKER_API_KEY: "picker-key",
  GOOGLE_DRIVE_PROJECT_NUMBER: "12345",
  GOOGLE_DRIVE_REDIRECT_URI: "https://dash.test/api/connectors/google-drive/oauth/callback",
  GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
beforeEach(() => Object.assign(process.env, env));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const oauthBinding = `${actor.id}:${actor.user.id}:google-drive:oauth`;
const accessBinding = `${actor.id}:${actor.user.id}:google-drive:access`;

function connectResponse(response: object) {
  const started = startDriveOAuth(actor);
  const params = new URLSearchParams({ state: new URL(started.url).searchParams.get("state")!, code: "one-use-code" });
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://oauth2.googleapis.com/token");
    const form = init!.body as URLSearchParams;
    const flow = JSON.parse(decryptToken(started.cookie, env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY, oauthBinding));
    expect(form.get("code_verifier")).toBe(flow.verifier);
    expect(form.get("client_secret")).toBe("drive-secret");
    return Response.json(response);
  }) as typeof fetch;
  return { started, params };
}

test("OAuth uses only drive.file with PKCE, short-lived access and encrypted org/user-bound state", () => {
  const started = startDriveOAuth(actor);
  const url = new URL(started.url);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("scope")).toBe(DRIVE_SCOPE);
  expect(url.searchParams.get("access_type")).toBe("online");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(started.cookie).not.toContain(url.searchParams.get("state")!);
  expect(() => driveAccess(started.cookie, actor)).toThrow(); // cookie purposes cannot be swapped
});

test("valid callback yields a bounded import session, not a refresh token", async () => {
  const { started, params } = connectResponse({ access_token: "narrow-token", refresh_token: "not-stored", expires_in: 7200, scope: DRIVE_SCOPE });
  const result = await finishDriveOAuth(started.cookie, actor, params);
  expect(result.lifetime).toBe(3600);
  expect(driveAccess(result.cookie, actor).accessToken).toBe("narrow-token");
  expect(decryptToken(result.cookie, env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY, accessBinding)).not.toContain("not-stored");
  expect(() => driveAccess(result.cookie, { ...actor, id: "other-org" })).toThrow();
  expect(() => driveAccess(result.cookie, { id: actor.id, user: { id: "other-user" } })).toThrow();
  expect(() => driveAccess(result.cookie.slice(1), actor)).toThrow();
});

test("rejects mismatched, expired, replay-without-cookie and cancelled OAuth before exchanging a code", async () => {
  const { started, params } = connectResponse({ access_token: "token", expires_in: 300, scope: DRIVE_SCOPE });
  params.set("state", "wrong-state");
  await expect(finishDriveOAuth(started.cookie, actor, params)).rejects.toThrow(/expired|started here/);
  await expect(finishDriveOAuth(undefined, actor, params)).rejects.toThrow(/Connect/);
  const flow = JSON.parse(decryptToken(started.cookie, env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY, oauthBinding));
  params.set("state", flow.state);
  params.set("error", "access_denied");
  await expect(finishDriveOAuth(started.cookie, actor, params)).rejects.toThrow(/cancelled/);
  params.delete("error");
  const expired = encryptToken(JSON.stringify({ ...flow, expires: 1 }), env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY, oauthBinding);
  await expect(finishDriveOAuth(expired, actor, params)).rejects.toThrow(/expired/);
});

test("rejects expired access cookies and consent without drive.file", async () => {
  const expired = encryptToken(JSON.stringify({ accessToken: "x", expires: 1 }), env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY, accessBinding);
  expect(() => driveAccess(expired, actor)).toThrow(/expired/);
  const { started, params } = connectResponse({ access_token: "token", expires_in: 300, scope: "openid" });
  await expect(finishDriveOAuth(started.cookie, actor, params)).rejects.toThrow(/not granted/);
});

test("requires same-origin mutations and a valid Google configuration", () => {
  expect(() => assertDriveOrigin(new Request("https://dash.test/api/connectors/google-drive/import", { headers: { origin: "https://evil.test" } }))).toThrow(/studio/);
  expect(() => assertDriveOrigin(new Request("https://dash.test/api/connectors/google-drive/import"))).toThrow(/studio/);
  assertDriveOrigin(new Request("https://dash.test/api/connectors/google-drive/import", { headers: { origin: "https://dash.test" } }));
  process.env.GOOGLE_DRIVE_REDIRECT_URI = "http://evil.test/callback";
  expect(driveConfig).toThrow(/HTTPS/);
  process.env.GOOGLE_DRIVE_REDIRECT_URI = env.GOOGLE_DRIVE_REDIRECT_URI;
  process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY = "invalid";
  expect(driveConfig).toThrow(/32 bytes/);
});

test("downloads binary files unchanged using server-fetched metadata", async () => {
  const urls: URL[] = [];
  const bytes = new Uint8Array([0, 255, 37, 80]);
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer token");
    expect(init!.redirect).toBe("error");
    return urls.length === 1 ? Response.json({ id: "file-1", name: "Brief.pdf", mimeType: "application/pdf", size: "4", capabilities: { canDownload: true } }) : new Response(bytes);
  }) as typeof fetch;
  const file = await downloadDriveFile("file-1", "token");
  expect(file.name).toBe("Brief.pdf");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  expect(urls[1].origin).toBe("https://www.googleapis.com");
  expect(urls[1].searchParams.get("alt")).toBe("media");
  await expect(downloadDriveFile("https://evil.test/data", "token")).rejects.toThrow();
});

for (const [type, ext] of [["document", "docx"], ["spreadsheet", "xlsx"], ["presentation", "pptx"]]) {
  test(`exports Google ${type} as ${ext}, not as a fake original`, async () => {
    let count = 0;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (++count === 1) return Response.json({ id: "file-1", name: "Plan", mimeType: `application/vnd.google-apps.${type}` });
      expect(url.pathname.endsWith("/export")).toBe(true);
      expect(url.searchParams.get("mimeType")).toContain("openxmlformats");
      return new Response("exported-bytes");
    }) as typeof fetch;
    const file = await downloadDriveFile("file-1", "token");
    expect(file.name).toBe(`Plan.${ext}`);
    expect(await file.text()).toBe("exported-bytes");
  });
}

test("rejects oversized, non-downloadable, unsupported and unauthorized files", async () => {
  for (const metadata of [
    { name: "huge.pdf", mimeType: "application/pdf", size: String(26 * 1024 * 1024) },
    { name: "private.pdf", mimeType: "application/pdf", capabilities: { canDownload: false } },
    { name: "Folder", mimeType: "application/vnd.google-apps.folder" },
  ]) {
    globalThis.fetch = (async () => Response.json({ id: "file-1", ...metadata })) as typeof fetch;
    await expect(downloadDriveFile("file-1", "token")).rejects.toThrow();
  }
  globalThis.fetch = (async () => new Response("permission denied", { status: 403 })) as typeof fetch;
  await expect(downloadDriveFile("file-1", "token")).rejects.toThrow(/unavailable/);
});

test("bounds streamed downloads even when Google metadata omits size", async () => {
  let count = 0;
  globalThis.fetch = (async () => ++count === 1
    ? Response.json({ id: "file-1", name: "large.pdf", mimeType: "application/pdf" })
    : new Response(new Uint8Array(25 * 1024 * 1024 + 1))) as typeof fetch;
  await expect(downloadDriveFile("file-1", "token")).rejects.toThrow(/25 MB/);
});
