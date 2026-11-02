"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

/**
 * After a change: refetch the data on screen. Pages load through useApi (React Query), so `router.refresh()` alone no
 * longer reloads them; the refresh stays for anything still rendered on the server.
 */
export function useRefresh() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries();
    router.refresh();
  }, [queryClient, router]);
}
