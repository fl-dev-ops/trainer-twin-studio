"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useEffect, useRef } from "react";
import posthog from "posthog-js";

// Pageview + identity wiring. Renders nothing; mounted once in the root layout.
export function PostHogTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = authClient.useSession();
  const identifiedId = useRef<string | null>(null);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || !pathname) return;
    posthog.capture("$pageview", { $current_url: window.location.href });
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    const userId = session?.user?.id;
    if (userId && userId !== identifiedId.current) {
      identifiedId.current = userId;
      posthog.identify(userId);
    } else if (!userId && identifiedId.current) {
      identifiedId.current = null;
      posthog.reset();
    }
  }, [session?.user?.id]);

  return null;
}
