import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/lib/app-router";
import { createTrpcContext } from "@/lib/trpc";

/** Mounts the app router at /api/trpc: twin, roleplay and the page loaders behind client pages (lib/api.ts). */
function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: (opts) => createTrpcContext({ req, requestId: opts.req.headers.get("x-request-id") ?? undefined }),
  });
}

export { handler as GET, handler as POST };
