"use client";

import { useSuspenseQuery, type QueryKey } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { redirect } from "next/navigation";
import superjson from "superjson";
import type { AppRouter } from "@/lib/app-router";

/** Browser client for /api/trpc (twin, roleplay and page loaders). Calls made in the same tick share one request. */
export const api = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })] });

/** Thrown while rendering a page whose record is missing; app/error.tsx shows the 404 page for it. */
export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor() {
    super("Not found");
    this.name = "NotFoundError";
  }
}

export const isNotFound = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "NOT_FOUND" ||
  (error instanceof TRPCClientError && (error.data as { code?: unknown } | undefined)?.code === "NOT_FOUND");

/** Call while rendering when the loaded data says the page doesn't exist (the old `notFound()`). */
export function pageNotFound(): never {
  throw new NotFoundError();
}

type Gate = "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN";
type Loaded<T> = { value: T } | { gate: Gate };

function gateOf(error: unknown): Gate | null {
  if (!(error instanceof TRPCClientError)) return null;
  const code = (error.data as { code?: unknown } | undefined)?.code;
  return code === "NOT_FOUND" || code === "UNAUTHORIZED" || code === "FORBIDDEN" ? code : null;
}

/**
 * A page's data, loaded in the browser. Suspends until ready (the route's loading.tsx shows meanwhile), then shows the
 * cached copy on later visits while it refetches in the background. The old page guards keep their meaning: a missing
 * record is the 404 page, no session goes to sign-in, a member without access to the org goes to /auth/no-org.
 * Load everything a page needs in one `load` (Promise.all) so the calls share one request.
 */
export function useApi<T>(key: QueryKey, load: () => Promise<T>): T {
  const { data } = useSuspenseQuery<Loaded<T>>({
    queryKey: key,
    queryFn: () =>
      load().then(
        (value) => ({ value }),
        (error: unknown) => {
          const gate = gateOf(error);
          if (gate) return { gate };
          throw error;
        },
      ),
    staleTime: 0,
    retry: 1,
  });
  if ("value" in data) return data.value;
  if (data.gate === "UNAUTHORIZED") redirect("/auth/sign-in");
  if (data.gate === "FORBIDDEN") redirect("/auth/no-org");
  return pageNotFound();
}
