import { initTRPC, TRPCError } from "@trpc/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * App-wide tRPC primitives: every feature can import `t`, `protectedProcedure`
 * and the context helpers from here. Feature routers (only `twin` today) build
 * on these and mount under /api/<feature>.
 */

export type TrpcUser = { id: string; name: string; orgId: string };

export type TrpcContext = {
  requestId?: string;
  user: TrpcUser | null;
};


export function createTrpcContext(opts: { req: Request; requestId?: string }): Promise<TrpcContext> {
  async function user(): Promise<TrpcUser | null> {
    const session = await auth.api.getSession({ headers: opts.req.headers });
    if (!session) return null;
    const member = await db.member.findFirst({
      where: { userId: session.user.id },
      select: { organizationId: true, user: { select: { id: true, name: true } } },
    });
    if (!member) return null;
    return { id: member.user.id, name: member.user.name, orgId: member.organizationId };
  }

  return user().then((user) => ({ requestId: opts.requestId, user }));
}

export const t = initTRPC.context<TrpcContext>().create();

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
