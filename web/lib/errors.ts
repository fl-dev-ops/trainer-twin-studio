import { TRPCError } from "@trpc/server";
import { APIError } from "better-auth/api";

/**
 * A refusal the platform knows (the "Refusals" tables in specs/*.md): a stable code, a status and our message. The same
 * condition gives the same code, status and message wherever it is checked. Routes answer `{ error, code }`
 * (errorResponse); tRPC errors carry the code in `data.code` (lib/trpc.ts); Better Auth hooks throw toAPIError.
 */
export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** The refusals every module shares (specs/people.md Refusals). */
export const refusals = {
  notFound: () => new AppError("not_found", "Not found.", 404),
  signedOut: () => new AppError("signed_out", "Sign in first.", 401),
  noOrg: () => new AppError("no_org", "You're not a member of this organization.", 403),
  studioOnly: () => new AppError("studio_only", "Only the organization's admin and team can do this.", 403),
  orgPinInvalid: () => new AppError("org_pin_invalid", "This tab's organization is no longer available to you. Reload the page.", 403),
  memberDisabled: () =>
    new AppError("member_disabled", "Your access to this organization has been turned off. Ask its admin to turn it back on.", 403),
  invalidInput: (message: string) => new AppError("invalid_input", message, 400),
};

/** A refusal as plain data: workflow steps return values, not errors (they don't survive serialisation). */
export type Refused = { ok: false; status: number; error: string; code: string };

/** The refusal as data (Refused); anything that isn't a refusal is rethrown. */
export function refusedOf(error: unknown): Refused {
  if (error instanceof AppError) return { ok: false, status: error.status, error: error.message, code: error.code };
  throw error;
}

/** `{ error, code }` with the refusal's status. Anything that isn't a refusal is rethrown (a 500, logged). */
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  throw error;
}

const trpcCodes: Record<number, TRPCError["code"]> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
};

/** A refusal as a tRPC error (the refusal stays its cause, so the formatter can add `data.code`). */
export const toTRPCError = (error: AppError) =>
  new TRPCError({ code: trpcCodes[error.status] ?? "INTERNAL_SERVER_ERROR", message: error.message, cause: error });

const apiStatuses: Record<number, ConstructorParameters<typeof APIError>[0]> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};

/** A refusal thrown from a Better Auth hook (its own error type is what it turns into a response). */
export const toAPIError = (error: AppError) =>
  new APIError(apiStatuses[error.status] ?? "INTERNAL_SERVER_ERROR", { message: error.message, code: error.code });
