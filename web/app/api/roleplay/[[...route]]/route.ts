import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { createTrpcContext } from "@/lib/trpc";

/** Mounts the role-play tRPC router at /api/roleplay (same shape as /api/twin). */
function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/roleplay",
    req,
    router: roleplayRouter,
    createContext: (opts) => createTrpcContext({ req, requestId: opts.req.headers.get("x-request-id") ?? undefined }),
  });
}

export { handler as GET, handler as POST };
