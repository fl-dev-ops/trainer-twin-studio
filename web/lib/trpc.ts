import { initTRPC, TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";

/**
 * App-wide tRPC primitives: every feature can import `t`, `protectedProcedure`, `studioProcedure`
 * and the context helpers from here. Feature routers (only `twin` today) build on these and mount
 * under /api/<feature>.
 */

export type TrpcUser = { id: string; name: string; email: string; orgId: string; orgSlug: string; role: string };

export type TrpcContext = {
  requestId?: string;
  user: TrpcUser | null;
};

async function userFrom(requestHeaders: Headers): Promise<TrpcUser | null> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const member = await db.member.findFirst({
    where: { userId: session.user.id },
    select: { role: true, organization: { select: { id: true, slug: true } } },
  });
  if (!member) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    orgId: member.organization.id,
    orgSlug: member.organization.slug,
    role: member.role,
  };
}

export async function createTrpcContext(opts: { req: Request; requestId?: string }): Promise<TrpcContext> {
  return { requestId: opts.requestId, user: await userFrom(opts.req.headers) };
}

/** The same context for server components (they call routers directly through `createCaller`). */
export async function createServerTrpcContext(): Promise<TrpcContext> {
  return { user: await userFrom(await headers()) };
}

export const t = initTRPC.context<TrpcContext>().create();

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Studio members only (admin, team): they manage twins and role plays. */
export const studioProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isStudioRole(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
