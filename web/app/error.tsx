"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import NotFound from "@/app/not-found";
import { isNotFound } from "@/lib/api";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Client pages report a missing record by throwing (lib/api.ts); it is the 404 page, not a crash.
  const missing = isNotFound(error);

  useEffect(() => {
    if (!missing && process.env.NEXT_PUBLIC_POSTHOG_KEY) posthog.captureException(error);
  }, [error, missing]);

  if (missing) return <NotFound />;

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-8 text-center">
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">An unexpected error occurred. Please try again.</p>
        <button type="button" onClick={reset} className="rounded-md border px-4 py-2 text-sm">
          Try again
        </button>
      </div>
    </div>
  );
}
