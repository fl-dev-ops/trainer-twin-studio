"use client";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { RoleplayRouter } from "@/lib/roleplay/trpc";

/** Browser client for /api/roleplay mutations; pages read through roleplayServer() and refresh after a change. */
export const roleplayClient = createTRPCClient<RoleplayRouter>({ links: [httpBatchLink({ url: "/api/roleplay" })] });
