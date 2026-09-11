import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { encryptNotionToken, notionTokenBinding } from "@/lib/notion-token";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_API_VERSION = process.env.NOTION_API_VERSION ?? "2022-06-28";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type NotionOAuthToken = {
  access_token?: string;
  refresh_token?: string | null;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  bot_id?: string;
};

function clientId() {
  const value = process.env.NOTION_OAUTH_CLIENT_ID?.trim();
  if (!value) throw new Error("NOTION_OAUTH_CLIENT_ID is not set");
  return value;
}

function clientSecret() {
  const value = process.env.NOTION_OAUTH_CLIENT_SECRET?.trim();
  if (!value) throw new Error("NOTION_OAUTH_CLIENT_SECRET is not set");
  return value;
}

/** Returns the redirect URI registered for the public Notion connection. */
export function notionOAuthRedirectUri() {
  const value = process.env.NOTION_OAUTH_REDIRECT_URI?.trim();
  if (value) {
    try {
      return new URL(value).toString();
    } catch {
      throw new Error("NOTION_OAUTH_REDIRECT_URI must be an absolute URL");
    }
  }
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000";
  return new URL("/api/connectors/notion/oauth/callback", appUrl).toString();
}

/** Persists a one-time OAuth state bound to the initiating org, trainer, and knowledge base. */
export async function createNotionOAuthState(
  orgId: string,
  userId: string,
  kbId: string,
  prefix = "",
) {
  const id = `${prefix}${randomBytes(32).toString("base64url")}`;
  await db.notionOAuthState.create({
    data: {
      id,
      orgId,
      userId,
      kbId,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  return id;
}

/** Atomically verifies user role, knowledge base ownership, consumes the state, and returns bound metadata in a single query. */
export async function consumeNotionOAuthState(
  id: string,
  orgId: string,
  userId: string,
) {
  const now = new Date();
  const result = await db.$queryRaw<
    {
      id: string;
      orgId: string;
      userId: string;
      kbId: string;
      kbSlug: string;
    }[]
  >`
    UPDATE "NotionOAuthState" s
    SET "consumedAt" = ${now}
    FROM "member" m, "KnowledgeBase" kb
    WHERE s.id = ${id}
      AND s."orgId" = ${orgId}
      AND s."userId" = ${userId}
      AND s."consumedAt" IS NULL
      AND s."expiresAt" > ${now}
      AND kb.id = s."kbId"
      AND kb."orgId" = ${orgId}
      AND m."organizationId" = ${orgId}
      AND m."userId" = ${userId}
      AND m.role ~* '(^|,)\s*(owner|admin)\s*(,|$)'
    RETURNING s.id, s."orgId", s."userId", s."kbId", kb.slug AS "kbSlug"
  `;

  if (result.length !== 1) return null;
  const row = result[0];
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    kbId: row.kbId,
    kb: { id: row.kbId, slug: row.kbSlug },
  };
}

/** Builds Notion's public-connection authorization URL. */
export function notionAuthorizationUrl(state: string) {
  const url = new URL(`${NOTION_API_URL}/oauth/authorize`);
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", notionOAuthRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchanges the short-lived OAuth code for a workspace-scoped Notion token. */
export async function exchangeNotionCode(
  code: string,
): Promise<NotionOAuthToken> {
  const startedAt = Date.now();
  console.info("[EXT-API:notion-oauth] start action=token-exchange");
  try {
    const credentials = Buffer.from(`${clientId()}:${clientSecret()}`).toString(
      "base64",
    );
    const response = await fetch(`${NOTION_API_URL}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: notionOAuthRedirectUri(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Notion OAuth returned ${response.status}: ${errorText}`);
    }
    const token = (await response.json()) as NotionOAuthToken;
    if (!token.access_token || !token.workspace_id) {
      throw new Error("Notion OAuth response is missing workspace credentials");
    }
    console.info(
      `[EXT-API:notion-oauth] complete action=token-exchange status=${response.status} elapsedMs=${Date.now() - startedAt}`,
    );
    return token;
  } catch (error) {
    console.error(
      `[EXT-API:notion-oauth] failed action=token-exchange elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

/** Upserts organization-owned Notion connection credentials with authorizing user audit and AAD binding. */
export async function saveNotionConnection(
  orgId: string,
  userId: string,
  token: NotionOAuthToken,
) {
  if (!token.access_token || !token.workspace_id) {
    throw new Error("Notion OAuth response is missing workspace credentials");
  }
  const tokenExpiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000)
    : null;
  const where = {
    orgId_workspaceId: { orgId, workspaceId: token.workspace_id },
  };

  const existing = await db.notionConnection.upsert({
    where,
    update: {},
    create: {
      id: randomUUID(),
      orgId,
      userId,
      workspaceId: token.workspace_id,
      workspaceName: token.workspace_name ?? null,
      workspaceIcon: token.workspace_icon ?? null,
      botId: token.bot_id ?? null,
      accessTokenCiphertext: "",
    },
  });

  const connectionId = existing.id;
  const boundUserId = existing.userId || userId;
  const binding = notionTokenBinding({
    orgId,
    userId: boundUserId,
    connectionId,
  });

  return db.notionConnection.update({
    where: { id: connectionId },
    data: {
      userId,
      workspaceName: token.workspace_name ?? null,
      workspaceIcon: token.workspace_icon ?? null,
      botId: token.bot_id ?? null,
      accessTokenCiphertext: encryptNotionToken(token.access_token, binding),
      refreshTokenCiphertext: token.refresh_token
        ? encryptNotionToken(token.refresh_token, binding)
        : existing.refreshTokenCiphertext,
      tokenExpiresAt,
    },
  });
}
