import { YouTubeError } from "./types";

export type YouTubeConfig = { clientId: string; clientSecret: string; encryptionKey: string };
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

/** Reads only YouTube credentials; importing this module does not require secrets. */
export function youtubeConfig(): YouTubeConfig {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new YouTubeError("NOT_CONFIGURED", "YouTube connection is not configured");
    return value;
  };
  return {
    clientId: required("YOUTUBE_OAUTH_CLIENT_ID"),
    clientSecret: required("YOUTUBE_OAUTH_CLIENT_SECRET"),
    encryptionKey: required("YOUTUBE_TOKEN_ENCRYPTION_KEY"),
  };
}

/** Bounds response memory and lifetime without exposing Google response bodies in logs. */
export async function googleRequest(operation: string, url: string, init: RequestInit = {}, limit = 10_000_000): Promise<string> {
  const startedAt = Date.now();
  console.info(`[EXT-API:youtube] start operation=${operation}`);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw new YouTubeError("RESPONSE_TOO_LARGE", "YouTube response exceeds the import size limit");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
    if (!response.ok) {
      let reason = "";
      try {
        const body = JSON.parse(text);
        reason = typeof body.error === "string" ? body.error : body.error?.errors?.[0]?.reason ?? "";
      } catch { /* Non-JSON responses are classified by HTTP status. */ }
      if (operation === "token-revoke" && reason === "invalid_token") return "";
      if (reason === "invalid_grant") throw new YouTubeError("RECONNECT_REQUIRED", "Reconnect your YouTube channel");
      if (response.status === 401) throw new YouTubeError("UNAUTHORIZED", "YouTube authorization expired");
      if (["quotaExceeded", "dailyLimitExceeded"].includes(reason)) throw new YouTubeError("QUOTA_EXCEEDED", "YouTube daily quota exhausted. Retry after the quota resets.");
      if (response.status === 429 || ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason)) throw new YouTubeError("RATE_LIMITED", "YouTube is rate limiting requests. Please retry shortly.", true);
      if (response.status >= 500) throw new YouTubeError("UNAVAILABLE", "YouTube is temporarily unavailable", true);
      if (response.status === 403) throw new YouTubeError("PERMISSION_DENIED", "YouTube did not grant access to this video or its captions");
      if (response.status === 404) throw new YouTubeError("NOT_FOUND", "Video or caption track is no longer available");
      throw new YouTubeError("GOOGLE_REJECTED", `YouTube rejected ${operation} (HTTP ${response.status})`);
    }
    console.info(`[EXT-API:youtube] complete operation=${operation} status=${response.status} elapsedMs=${Date.now() - startedAt}`);
    return text;
  } catch (error) {
    const safe = error instanceof YouTubeError ? error : new YouTubeError("NETWORK_ERROR", "Could not reach YouTube. Please retry.", true);
    console.error(`[EXT-API:youtube] failed operation=${operation} code=${safe.code} elapsedMs=${Date.now() - startedAt}`);
    throw safe;
  }
}

export type GoogleToken = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

export async function exchangeGoogleToken(config: YouTubeConfig, fields: Record<string, string>): Promise<GoogleToken> {
  const raw = await googleRequest("token-exchange", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
  }, 64_000);
  const token = JSON.parse(raw) as GoogleToken;
  if (!token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new YouTubeError("INVALID_TOKEN", "Google returned incomplete authorization credentials");
  }
  if (token.scope && !token.scope.split(" ").includes(YOUTUBE_SCOPE)) {
    throw new YouTubeError("SCOPE_REQUIRED", "Grant the requested YouTube caption permission to connect");
  }
  return token;
}

export async function listOwnedChannels(token: string): Promise<{ id: string; title: string }[]> {
  const channels: { id: string; title: string }[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ part: "snippet", mine: "true", maxResults: "50", ...(pageToken ? { pageToken } : {}) });
    const raw = await googleRequest("owned-channels", `https://www.googleapis.com/youtube/v3/channels?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = JSON.parse(raw) as { items?: { id: string; snippet: { title: string } }[]; nextPageToken?: string };
    channels.push(...(data.items ?? []).map((channel) => ({ id: channel.id, title: channel.snippet.title })));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return channels;
}
