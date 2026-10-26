"use client";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { TwinRouter } from "@/lib/twin/trpc";

/** Browser client for /api/twin mutations; pages read through twinServer() and refresh after a change. */
export const twinClient = createTRPCClient<TwinRouter>({ links: [httpBatchLink({ url: "/api/twin" })] });
