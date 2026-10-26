import { protectedProcedure, t } from "@/lib/trpc";

/**
 * Twin-scoped tRPC surface. Built on the app-wide primitives in lib/trpc.ts;
 * mounted at /api/twin by the catch-all route. The rest of the app keeps its
 * plain REST routes.
 */
export const twinRouter = t.router({
  /** Who is talking to us over /api/twin. */
  me: protectedProcedure.query(({ ctx }) => ctx.user),
});

export type TwinRouter = typeof twinRouter;
