import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { exchangeGoogleToken, type YouTubeConfig } from "./http.server";
import type { ConnectionStore, StoredConnection } from "./connection-store.server";
import { YouTubeError, type ConnectionScope } from "./types";

function key(encoded: string) {
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new YouTubeError("NOT_CONFIGURED", "YouTube token encryption key must contain 32 bytes");
  return value;
}

/** Binds ciphertext to its connection so tokens cannot be swapped between tenants. */
export function encryptToken(token: string, encryptionKey: string, binding: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(encryptionKey), iv);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptToken(payload: string, encryptionKey: string, binding: string) {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new YouTubeError("INVALID_CREDENTIALS", "Stored YouTube credentials are invalid");
  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(encryptionKey), iv);
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new YouTubeError("INVALID_CREDENTIALS", "Stored YouTube credentials cannot be decrypted");
  }
}

export function tokenBinding(scope: ConnectionScope) { return `${scope.orgId}:${scope.userId}:${scope.connectionId}`; }

/** Keeps refresh coordination private; callers only perform an authorized operation. */
export function createAuthorizedRequests(store: ConnectionStore, config: YouTubeConfig) {
  const valid = (connection: StoredConnection) => Boolean(connection.accessTokenCiphertext && connection.tokenExpiresAt && new Date(connection.tokenExpiresAt).getTime() > Date.now() + 60_000);
  async function load(scope: ConnectionScope) {
    const connection = await store.get(scope);
    if (!connection || connection.status !== "active") throw new YouTubeError("RECONNECT_REQUIRED", "Reconnect your YouTube channel");
    return connection;
  }
  async function access(scope: ConnectionScope) {
    let connection = await load(scope);
    if (valid(connection)) return connection;
    const leaseId = randomUUID();
    if (!(await store.acquire(scope, leaseId))) {
      // Do not burn a Lambda invocation waiting on another worker's network call.
      connection = await load(scope);
      if (valid(connection)) return connection;
      throw new YouTubeError("REFRESH_BUSY", "YouTube connection is refreshing. Please retry shortly.", true);
    }
    const startedAt = Date.now();
    console.info("[EXT-API:youtube-refresh] start");
    try {
      connection = await load(scope);
      if (valid(connection)) return connection;
      if (!connection.refreshTokenCiphertext) throw new YouTubeError("RECONNECT_REQUIRED", "Reconnect your YouTube channel");
      const binding = tokenBinding(scope);
      const token = await exchangeGoogleToken(config, {
        grant_type: "refresh_token",
        refresh_token: decryptToken(connection.refreshTokenCiphertext, config.encryptionKey, binding),
      });
      const saved = await store.save(scope, leaseId,
        encryptToken(token.access_token, config.encryptionKey, binding),
        token.refresh_token ? encryptToken(token.refresh_token, config.encryptionKey, binding) : null,
        new Date(Date.now() + token.expires_in * 1000));
      if (!saved) throw new YouTubeError("CONNECTION_CHANGED", "YouTube connection changed. Please retry.", true);
      return await load(scope);
    } catch (error) {
      if (error instanceof YouTubeError && ["RECONNECT_REQUIRED", "UNAUTHORIZED"].includes(error.code)) await store.requireReconnect(scope, leaseId);
      console.error(`[EXT-API:youtube-refresh] failed code=${error instanceof YouTubeError ? error.code : "STORAGE_ERROR"} elapsedMs=${Date.now() - startedAt}`);
      throw error;
    } finally {
      await store.release(scope, leaseId);
      console.info(`[EXT-API:youtube-refresh] finish elapsedMs=${Date.now() - startedAt}`);
    }
  }
  return async <T>(scope: ConnectionScope, operation: (token: string, connection: StoredConnection) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const connection = await access(scope);
      try {
        return await operation(decryptToken(connection.accessTokenCiphertext!, config.encryptionKey, tokenBinding(scope)), connection);
      } catch (error) {
        if (!(error instanceof YouTubeError) || error.code !== "UNAUTHORIZED" || attempt > 0) throw error;
        await store.expire(scope, connection.accessTokenCiphertext!);
      }
    }
    throw new YouTubeError("RECONNECT_REQUIRED", "Reconnect your YouTube channel");
  };
}
