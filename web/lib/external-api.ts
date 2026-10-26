import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export type ExternalApiResource = "users" | "sessions" | "assignments" | "scenarios";

/**
 * The public API's name for a learner's role. docs/openapi.yaml promises `User.role: const member`;
 * the database calls the same role `user` (LEARNER_ROLE). Keep this value unless the API is versioned.
 */
export const API_LEARNER_ROLE = "member" as const;
export type ExternalApiAction = "read" | "write";
export type ExternalApiContext = {
  org: { id: string; slug: string; name: string };
  keyId: string;
  actorUserId: string | null;
};

export function externalApiKey(request: Request) {
  const header = request.headers.get("x-api-key")?.trim();
  if (header) return header;
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

export async function requireExternalApi(
  request: Request,
  resource: ExternalApiResource,
  action: ExternalApiAction,
): Promise<ExternalApiContext | Response> {
  const key = externalApiKey(request);
  if (!key) return Response.json({ error: "Missing API key" }, { status: 401 });

  const verification = await auth.api.verifyApiKey({
    body: { key, permissions: { [resource]: [action] } },
  });
  if (!verification.valid || !verification.key) {
    const status = verification.error?.code === "RATE_LIMIT_EXCEEDED" ? 429 : 401;
    return Response.json(
      { error: status === 429 ? "API rate limit exceeded" : "Invalid API key" },
      { status },
    );
  }

  const org = await db.organization.findUnique({
    where: { id: verification.key.referenceId },
    select: { id: true, slug: true, name: true },
  });
  if (!org) return Response.json({ error: "API key organization not found" }, { status: 401 });

  const metadata = verification.key.metadata as { createdByUserId?: unknown } | null;
  return {
    org,
    keyId: verification.key.id,
    actorUserId: typeof metadata?.createdByUserId === "string" ? metadata.createdByUserId : null,
  };
}

export function isApiError(value: ExternalApiContext | Response): value is Response {
  return value instanceof Response;
}

/** Collection pagination per the API contract: limit 1–100 (default 50), offset >= 0
 * (default 0). Present-but-invalid values return a 400 Response instead of being clamped. */
export function paginationFromUrl(url: URL): { limit: number; offset: number } | Response {
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
  const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0;
  if (!valid) return Response.json({ error: "Invalid pagination" }, { status: 400 });
  return { limit, offset };
}
