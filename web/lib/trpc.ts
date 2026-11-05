import { initTRPC, TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import superjson from "superjson";
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
};

async function userFrom(requestHeaders: Headers): Promise<Pick<TrpcContext, "user" | "signedIn">> {
  // The org this request works in, as for getSessionOrg / getTrainerOrg (lib/org.ts): pinned tab, active org, oldest.
  const current = await currentMembership(requestHeaders);
  if (!current) return { user: null, signedIn: false };
  const { session, member } = current;
  if (!member) return { user: null, signedIn: true };
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

// superjson: Dates (and Map/Set) reach client pages as they did through server-component props.
export const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

/** Anyone, signed in or not: learner-portal pages resolve the org from the host themselves. */
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  // Signed in without an org is FORBIDDEN (pages send it to /auth/no-org); no session at all is UNAUTHORIZED (sign-in).
  if (!ctx.user) throw new TRPCError({ code: ctx.signedIn ? "FORBIDDEN" : "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Studio members only (admin, team): they manage twins and role plays. */
export const studioProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isStudioRole(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
