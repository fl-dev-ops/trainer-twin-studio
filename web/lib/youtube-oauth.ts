import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { exchangeGoogleToken, listOwnedChannels, youtubeConfig, YOUTUBE_SCOPE } from "../../shared/youtube/http.server";
import { encryptToken, tokenBinding } from "../../shared/youtube/tokens.server";
import { YouTubeError } from "../../shared/youtube/types";

export function youtubeRedirectUri() {
  const value = process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim();
  if (!value) throw new YouTubeError("NOT_CONFIGURED", "YouTube OAuth redirect URI is not configured");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("YouTube redirect URI must use HTTPS");
  return url.toString();
}

/** Creates single-use state and PKCE bound to the initiating user, org and KB. */
export async function startYouTubeOAuth(orgId: string, userId: string, kbSlug: string) {
  const config = youtubeConfig();
  const redirectUri = youtubeRedirectUri();
  const kb = await db.knowledgeBase.findFirst({ where: { slug: kbSlug, orgId }, select: { id: true } });
  if (!kb) throw new Error("Knowledge base not found");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  await db.youTubeOAuthState.create({ data: { id: state, orgId, userId, kbId: kb.id, codeVerifier: verifier, expiresAt: new Date(Date.now() + 10 * 60_000) } });
  const query = new URLSearchParams({
    client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: YOUTUBE_SCOPE,
    access_type: "offline", prompt: "consent select_account", state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

/** Consumes callback state before exchanging any code; no token is returned to the browser. */
export async function finishYouTubeOAuth(orgId: string, userId: string, params: URLSearchParams) {
  const state = await db.youTubeOAuthState.findFirst({ where: { id: params.get("state") ?? "", orgId, userId }, include: { kb: { select: { slug: true, orgId: true } } } });
  if (!state || state.kb.orgId !== orgId || state.consumedAt || state.expiresAt <= new Date()) throw new Error("YouTube authorization expired. Please connect again.");
  const consumed = await db.youTubeOAuthState.updateMany({
    where: { id: state.id, orgId, userId, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new Error("YouTube authorization already used");
  if (params.has("error")) return { kbSlug: state.kb.slug, status: "cancelled" };
  const code = params.get("code");
  if (!code) throw new Error("Missing YouTube authorization code");
  const config = youtubeConfig();
  const token = await exchangeGoogleToken(config, { code, code_verifier: state.codeVerifier, grant_type: "authorization_code", redirect_uri: youtubeRedirectUri() });
  const channels = await listOwnedChannels(token.access_token);
  if (!channels.length) throw new YouTubeError("NO_CHANNEL", "This Google account has no accessible owned YouTube channel");
  for (const channel of channels) {
    const where = { orgId_userId_channelId: { orgId, userId, channelId: channel.id } };
    // Resolve the persisted ID before encryption, including concurrent first-time callbacks.
    const existing = await db.youTubeConnection.upsert({ where, update: {}, create: {
      id: randomUUID(), orgId, userId, channelId: channel.id, channelTitle: channel.title, status: "reconnect_required",
    } });
    if (existing.status === "disconnecting") throw new Error("Channel removal is still in progress. Retry after cleanup completes.");
    if (!token.refresh_token && !existing.refreshTokenCiphertext) throw new YouTubeError("RECONNECT_REQUIRED", "Google did not grant background access. Revoke the old grant and connect again.");
    const id = existing.id;
    const binding = tokenBinding({ connectionId: id, orgId, userId });
    const credentials = {
      channelTitle: channel.title, status: "active", accessTokenCiphertext: encryptToken(token.access_token, config.encryptionKey, binding),
      refreshTokenCiphertext: token.refresh_token ? encryptToken(token.refresh_token, config.encryptionKey, binding) : existing.refreshTokenCiphertext,
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000), refreshLeaseId: null, refreshLeaseExpiresAt: null, lastVerifiedAt: new Date(),
    };
    const saved = await db.youTubeConnection.updateMany({ where: { id, orgId, userId, status: { not: "disconnecting" } }, data: credentials });
    if (!saved.count) throw new Error("Channel removal started during authorization. Connect again after cleanup completes.");
  }
  return { kbSlug: state.kb.slug, status: "connected" };
}
