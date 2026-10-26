import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { twinRouter } from "@/lib/twin/trpc";
import { createTrpcContext } from "@/lib/trpc";

/**
 * Mounts the twin-scoped tRPC router at /api/twin (queries, mutations, and
 * subscriptions under one catch-all).
 */
function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/twin",
    req,
    router: twinRouter,
    createContext: (opts) => createTrpcContext({ req, requestId: opts.req.headers.get("x-request-id") ?? undefined }),
  });
}

export { handler as GET, handler as POST };
