import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { encryptToken, decryptToken } from "@shared/youtube/tokens.server";
import { ALL_DOCUMENT_EXTENSIONS } from "@/lib/documents";
import { BASE_DOMAIN } from "@/lib/base-domain";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_PATH = "/api/connectors/google-drive";
export const DRIVE_STATE_COOKIE = "tt_drive_oauth";
export const DRIVE_TOKEN_COOKIE = "tt_drive_access";
const MAX_BYTES = 25 * 1024 * 1024;
export const driveFileId = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(200);
export type DriveActor = { id: string; user: { id: string } };

export class DriveError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function driveConfig() {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new DriveError("Google Drive is not configured. Ask your admin to finish Google Cloud setup.", 503);
    return value;
  };
  const redirect = new URL(required("GOOGLE_DRIVE_REDIRECT_URI"));
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname))) {
    throw new DriveError("Google Drive redirect must use HTTPS", 503);
  }
  const localBridge = ["localhost", "127.0.0.1"].includes(redirect.hostname);
  if (localBridge && (process.env.NODE_ENV === "production" || !BASE_DOMAIN.endsWith(".localhost") || redirect.pathname !== `${DRIVE_PATH}/oauth/local-callback`)) {
    throw new DriveError("The localhost callback bridge is only available for a local development studio.", 503);
  }
  const studioOrigin = localBridge ? `https://dash.${BASE_DOMAIN}` : redirect.origin;
  const encryptionKey = required("GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY");
  if (Buffer.from(encryptionKey, "base64").length !== 32) throw new DriveError("Google Drive encryption key must contain 32 bytes", 503);
  return {
    clientId: required("GOOGLE_DRIVE_CLIENT_ID"), clientSecret: required("GOOGLE_DRIVE_CLIENT_SECRET"),
    pickerKey: required("GOOGLE_DRIVE_PICKER_API_KEY"), projectNumber: required("GOOGLE_DRIVE_PROJECT_NUMBER"),
    redirectUri: redirect.toString(), studioOrigin, localBridge, encryptionKey,
  };
}

export const driveCookieOptions = () => ({ httpOnly: true, sameSite: "lax" as const, secure: new URL(driveConfig().studioOrigin).protocol === "https:", path: DRIVE_PATH });
const binding = (actor: DriveActor, purpose: string) => `${actor.id}:${actor.user.id}:google-drive:${purpose}`;
const stateSchema = z.object({ state: z.string(), verifier: z.string(), expires: z.number() });
const tokenSchema = z.object({ accessToken: z.string().min(1), expires: z.number() });

function openCookie(value: string | undefined, actor: DriveActor, purpose: string) {
  if (!value) throw new DriveError("Connect Google Drive to choose files.", 401);
  try { return JSON.parse(decryptToken(value, driveConfig().encryptionKey, binding(actor, purpose))); }
  catch { throw new DriveError("Google Drive authorization is invalid. Connect again.", 401); }
}

export function driveAccess(value: string | undefined, actor: DriveActor) {
  const token = tokenSchema.safeParse(openCookie(value, actor, "access"));
  if (!token.success || token.data.expires <= Date.now() + 30_000) throw new DriveError("Google Drive authorization expired. Connect again.", 401);
  return token.data;
}

/** One import session, no refresh tokens or permanent connection. The cookie is encrypted and bound to org + user. */
export function startDriveOAuth(actor: DriveActor) {
  const config = driveConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const cookie = encryptToken(JSON.stringify({ state, verifier, expires: Date.now() + 10 * 60_000 }), config.encryptionKey, binding(actor, "oauth"));
  const query = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: DRIVE_SCOPE,
    access_type: "online", prompt: "select_account", state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  return { cookie, url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
}

export async function finishDriveOAuth(value: string | undefined, actor: DriveActor, params: URLSearchParams) {
  const config = driveConfig();
  const flow = stateSchema.safeParse(openCookie(value, actor, "oauth"));
  const state = params.get("state") ?? "";
  if (!flow.success || flow.data.expires <= Date.now() || state.length !== flow.data.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.data.state))) {
    throw new DriveError("Google authorization expired or was not started here. Connect again.", 401);
  }
  if (params.has("error")) throw new DriveError("Google Drive connection cancelled.");
  const code = params.get("code");
  if (!code) throw new DriveError("Google did not return an authorization code.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code", code, code_verifier: flow.data.verifier }),
  });
  if (!response.ok) throw new DriveError("Google authorization failed. Connect again.", 401);
  const token = z.object({ access_token: z.string().min(1).max(3000), expires_in: z.number().positive(), scope: z.string() }).parse(await response.json());
  if (!token.scope.split(" ").includes(DRIVE_SCOPE)) throw new DriveError("Google Drive file access was not granted.", 403);
  const lifetime = Math.min(token.expires_in, 3600);
  return {
    cookie: encryptToken(JSON.stringify({ accessToken: token.access_token, expires: Date.now() + lifetime * 1000 }), config.encryptionKey, binding(actor, "access")),
    lifetime,
  };
}

/** Picker gets only the narrow, short-lived access token; never the client secret or a refresh token. */
export function assertDriveOrigin(request: Request) {
  const expected = driveConfig().studioOrigin;
  // TLS proxies can leave request.url pointing at localhost; Host still identifies the public studio.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (host !== new URL(expected).host || request.headers.get("origin") !== expected) {
    throw new DriveError("Request must come from this studio.", 403);
  }
}

async function driveFetch(url: URL, token: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) throw new DriveError("This file is unavailable. Reconnect Google Drive and select it again.", response.status);
    throw new DriveError("Google Drive could not download this file. Try again.", 502);
  }
  return response;
}

const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
};

/** Only fixed Google API URLs are fetched; browser-supplied names, MIME types, sizes and download URLs are ignored. */
export async function downloadDriveFile(id: string, token: string) {
  driveFileId.parse(id);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,size,capabilities(canDownload)");
  const metadata = z.object({
    id: z.string(), name: z.string().min(1).max(1000), mimeType: z.string(), size: z.string().optional(),
    capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
  }).parse(await (await driveFetch(url, token)).json());
  if (metadata.capabilities?.canDownload === false) throw new DriveError("The owner has disabled downloads for this file.", 403);
  if (metadata.size && (!/^\d+$/.test(metadata.size) || Number(metadata.size) > MAX_BYTES)) throw new DriveError("Files must be 25 MB or smaller.");
  const exported = EXPORTS[metadata.mimeType];
  const name = exported ? `${metadata.name}.${exported.ext}` : metadata.name;
  const ext = name.split(".").pop()?.toLowerCase();
  if (!ext || !ALL_DOCUMENT_EXTENSIONS.includes(ext as (typeof ALL_DOCUMENT_EXTENSIONS)[number])) throw new DriveError("Choose a supported document, not a folder, shortcut or other unsupported file.");
  const download = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}${exported ? "/export" : ""}`);
  if (exported) download.searchParams.set("mimeType", exported.mime);
  else { download.searchParams.set("alt", "media"); download.searchParams.set("supportsAllDrives", "true"); }
  const response = await driveFetch(download, token);
  const reader = response.body?.getReader();
  if (!reader) throw new DriveError("Google returned an empty file.", 502);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new DriveError("Files must be 25 MB or smaller.");
      chunks.push(new Uint8Array(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return new File(chunks, name, { type: exported?.mime ?? metadata.mimeType });
}
