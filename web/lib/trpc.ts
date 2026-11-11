import { initTRPC } from "@trpc/server";
import { headers } from "next/headers";
import superjson from "superjson";
import { AppError, refusals, toTRPCError } from "@/lib/errors";
import { currentMembership, isStudioRole } from "@/lib/org";

/**
 * App-wide tRPC primitives: every feature can import `t`, `protectedProcedure`, `studioProcedure`
 * and the context helpers from here. Feature routers (only `twin` today) build on these and mount
 * under /api/<feature>.
 */

export type TrpcUser = { id: string; name: string; email: string; orgId: string; orgSlug: string; role: string };

export type TrpcContext = {
  requestId?: string;
  user: TrpcUser | null;
  /** Signed in, even when `user` is null for want of an (enabled) membership. */
  signedIn?: boolean;
  /** Why `user` is null when signed in (no_org, org_pin_invalid). */
  refusal?: AppError | null;
};

async function userFrom(requestHeaders: Headers): Promise<Pick<TrpcContext, "user" | "signedIn" | "refusal">> {
  // The org this request works in, as for getSessionOrg / getTrainerOrg (lib/org.ts): pinned tab, active org, oldest.
  const current = await currentMembership(requestHeaders);
  if (!current) return { user: null, signedIn: false };
  const { session, member, refusal } = current;
  if (!member) return { user: null, signedIn: true, refusal };
  return {
    signedIn: true,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      orgId: member.organization.id,
      orgSlug: member.organization.slug,
      role: member.role,
    },
  };
}

export async function createTrpcContext(opts: { req: Request; requestId?: string }): Promise<TrpcContext> {
  return { requestId: opts.requestId, ...(await userFrom(opts.req.headers)) };
}

/** The same context for server components (they call routers directly through `createCaller`). */
export async function createServerTrpcContext(): Promise<TrpcContext> {
  return userFrom(await headers());
}

// superjson: Dates (and Map/Set) reach client pages as they did through server-component props. Our refusals
// (lib/errors.ts) keep their tRPC code (pages redirect on it) and add their own as `data.refusal`.
export const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => {
    const refusal = error.cause instanceof AppError ? error.cause.code : error.code === "BAD_REQUEST" ? "invalid_input" : error.code === "NOT_FOUND" ? "not_found" : null;
    return refusal ? { ...shape, data: { ...shape.data, refusal } } : shape;
  },
});

/** A refusal thrown anywhere below becomes its tRPC error, with its status and message. */
const refusalsAsTrpc = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof AppError) throw toTRPCError(result.error.cause);
  return result;
});

/** Anyone, signed in or not: learner-portal pages resolve the org from the host themselves. */
export const publicProcedure = t.procedure.use(refusalsAsTrpc);

export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  // Signed in without an org is FORBIDDEN (pages send it to /auth/no-org); no session at all is UNAUTHORIZED (sign-in).
  if (!ctx.user) throw toTRPCError(ctx.refusal ?? (ctx.signedIn ? refusals.noOrg() : refusals.signedOut()));
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Studio members only (admin, team): they manage twins and role plays. */
export const studioProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isStudioRole(ctx.user.role)) throw toTRPCError(refusals.studioOnly());
  return next({ ctx });
});
