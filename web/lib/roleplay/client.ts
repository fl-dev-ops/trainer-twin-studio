"use client";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { RoleplayRouter } from "@/lib/roleplay/trpc";

/** Browser client for /api/roleplay mutations; pages read through useApi (lib/api.ts). */
export const roleplayClient = createTRPCClient<RoleplayRouter>({ links: [httpBatchLink({ url: "/api/roleplay", transformer: superjson })] });
