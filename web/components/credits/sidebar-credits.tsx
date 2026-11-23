"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** How often the studio checks whether the org's credits changed (minutes.version: a database read, no Meteroid call). */
const CHECK_EVERY_MS = 5_000;
/** Everything that shows credit numbers: reloaded when they change. */
const CREDIT_QUERIES = ["minutes.org", "page.usage", "minutes.activity", "minutes.learner", "page.users"];

/**
 * Reloads the studio's credit numbers when the org's credits change anywhere: a grant or expiry in Meteroid, minutes
 * given by another admin, a call that ended. Mounted once, with the sidebar.
 */
function useLiveCredits() {
  const queryClient = useQueryClient();
  const { data: version } = useQuery({ queryKey: ["minutes.version"], queryFn: () => api.minutes.version.query(), refetchInterval: CHECK_EVERY_MS });
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!version) return;
    if (seen.current !== null && seen.current !== version) {
      for (const key of CREDIT_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    seen.current = version;
  }, [version, queryClient]);
}

/** Keep credits live while the account menu is closed, not only while its popup is mounted. */
export function useSidebarCredits() {
  useLiveCredits();
  const { data } = useQuery({ queryKey: ["minutes.org"], queryFn: () => api.minutes.org.query(), staleTime: 60_000 });
  return data;
}
