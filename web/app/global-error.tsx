"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_POSTHOG_KEY) posthog.captureException(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full items-center justify-center p-8 text-center">
        <div className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">An unexpected error occurred. Please try again.</p>
          <button type="button" onClick={reset} className="rounded-md border px-4 py-2 text-sm">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
