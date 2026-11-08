import { minutesRouter } from "@/lib/minutes-trpc";
import { pageRouter } from "@/lib/pages/router";
import { roleplayRouter } from "@/lib/roleplay/trpc";
import { t } from "@/lib/trpc";
import { twinRouter } from "@/lib/twin/trpc";

/** Everything the browser reads, mounted at /api/trpc (lib/api.ts). /api/twin and /api/roleplay still serve their routers alone. */
export const appRouter = t.router({ twin: twinRouter, roleplay: roleplayRouter, page: pageRouter, minutes: minutesRouter });

export type AppRouter = typeof appRouter;
