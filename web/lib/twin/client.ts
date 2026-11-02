"use client";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { TwinRouter } from "@/lib/twin/trpc";

/** Browser client for /api/twin mutations; pages read through useApi (lib/api.ts). */
export const twinClient = createTRPCClient<TwinRouter>({ links: [httpBatchLink({ url: "/api/twin", transformer: superjson })] });
