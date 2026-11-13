import { auth } from "@/lib/auth";
import { AppError, errorResponse, refusals } from "@/lib/errors";
import { STUDIO_ROLES } from "@/lib/roles";
import { LEARNER, orgPeople, orgPerson, type OrgPerson } from "@/lib/org-people";
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
  /** The enabled admin/team member who created the key: the API acts as them (specs/people.md rule 22). */
  trainer: OrgPerson;
  actorUserId: string;
};

export function externalApiKey(request: Request) {
  const header = request.headers.get("x-api-key")?.trim();
  if (header) return header;
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

/** Too many requests for this key: retry after `retryAfter` seconds (specs/api.md rule 1). */
export class RateLimitedError extends AppError {
  constructor(readonly retryAfter: number) {
    super("rate_limited", `Too many requests. Try again in ${retryAfter} seconds.`, 429);
  }
}

export const apiRefusals = {
  keyInvalid: () => new AppError("api_key_invalid", "Send a valid API key.", 401),
  scopeMissing: (resource: ExternalApiResource, action: ExternalApiAction) => new AppError("scope_missing", `This API key can't ${action} ${resource}.`, 403),
  ownerGone: () => new AppError("api_key_owner_gone", "This API key's owner is no longer on the team. Create a new key.", 403),
  internal: () => new AppError("internal_error", "Something went wrong. Try again.", 500),
};

/**
 * The org and trainer an API request acts for (specs/api.md rule 1), or our refusal: api_key_invalid (missing,
 * unknown, expired or disabled key, org gone), scope_missing, rate_limited, api_key_owner_gone.
 */
export async function requireExternalApi(request: Request, resource: ExternalApiResource, action: ExternalApiAction): Promise<ExternalApiContext> {
  const key = externalApiKey(request);
  if (!key) throw apiRefusals.keyInvalid();
  const verification = await auth.api.verifyApiKey({ body: { key, permissions: { [resource]: [action] } } });
  if (!verification.valid || !verification.key) {
    // The api-key plugin's codes (@better-auth/api-key): KEY_NOT_FOUND here means the permission is missing.
    const error = verification.error as { code?: unknown; details?: { tryAgainIn?: unknown } } | null | undefined;
    if (error?.code === "RATE_LIMITED" || error?.code === "USAGE_EXCEEDED") {
      const ms = typeof error.details?.tryAgainIn === "number" ? error.details.tryAgainIn : 60_000;
      throw new RateLimitedError(Math.max(1, Math.ceil(ms / 1000)));
    }
    if (error?.code === "KEY_NOT_FOUND") throw apiRefusals.scopeMissing(resource, action);
    if (error?.code === "FAILED_TO_UPDATE_API_KEY") throw apiRefusals.internal();
    throw apiRefusals.keyInvalid();
  }
  const org = await db.organization.findUnique({ where: { id: verification.key.referenceId }, select: { id: true, slug: true, name: true } });
  if (!org) throw apiRefusals.keyInvalid();
  const metadata = verification.key.metadata as { createdByUserId?: unknown } | null;
  const creator = typeof metadata?.createdByUserId === "string" ? metadata.createdByUserId : null;
  const [trainer] = creator ? await orgPeople(org.id, { roles: [...STUDIO_ROLES], userIds: [creator] }) : [];
  if (!trainer) throw apiRefusals.ownerGone();
  return { org, keyId: verification.key.id, trainer, actorUserId: trainer.userId };
}

/**
 * Every /api/v1 resource route's handler (specs/api.md rule 2): our refusals answer `{ error, code }` with their
 * status (and Retry-After when rate limited); anything else is logged and answered internal_error, never a bare 500.
 */
export function apiRoute<A extends unknown[]>(handler: (request: Request, ...rest: A) => Promise<Response>) {
  return async (request: Request, ...rest: A): Promise<Response> => {
    try {
      return await handler(request, ...rest);
    } catch (error) {
      if (!(error instanceof AppError)) {
        console.error(`[api] ${request.method} ${new URL(request.url).pathname} failed:`, error);
        return errorResponse(apiRefusals.internal());
      }
      const response = errorResponse(error);
      if (error instanceof RateLimitedError) response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
  };
}

/** Kept for the route pattern `if (isApiError(api)) return api`: requireExternalApi throws its refusals now. */
export function isApiError(value: ExternalApiContext | Response): value is Response {
  return value instanceof Response;
}

/**
 * A learner of the key's organization, by user ID or email (active members only). Every API lookup of a user goes
 * through here: a user of another organization answers like an unknown one (docs/limits.mdx, organization isolation).
 */
export async function findOrgLearner(orgId: string, by: { id: string } | { email: string }) {
  const person = await orgPerson(orgId, "id" in by ? { userId: by.id } : { email: by.email });
  return person && person.role === LEARNER && !person.disabled ? person : null;
}

/** Collection pagination per the API contract: limit 1–100 (default 50), offset >= 0
 * (default 0). Present-but-invalid values throw invalid_input instead of being clamped. */
export function paginationFromUrl(url: URL): { limit: number; offset: number } {
  const limitText = url.searchParams.get("limit") ?? "50";
  const offsetText = url.searchParams.get("offset") ?? "0";
  const limit = Number(limitText);
  const offset = Number(offsetText);
  // Prisma skip is a signed 32-bit integer; reject coercions/overflow rather than producing a database 500.
  const valid = /^\d+$/.test(limitText) && /^\d+$/.test(offsetText) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    && Number.isSafeInteger(offset) && offset >= 0 && offset <= 2_147_483_647;
  if (!valid) throw refusals.invalidInput("limit must be 1–100 and offset 0 or more.");
  return { limit, offset };
}
