"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { twinClient } from "@/lib/twin/client";
import type { ReportState } from "@/lib/twin/session-report";

/**
 * Quiet polling while a twin session's report is being made: every 3s, paused in background tabs
 * (React Query default), never surfacing errors (a failed poll just polls again). When the report lands,
 * the server data is refreshed so the page shows it.
 */
export function useSessionReportState(id: string, initial: ReportState): ReportState {
  const router = useRouter();
  const { data } = useQuery({
    queryKey: ["twin-report-state", id],
    queryFn: () => twinClient.sessions.reportState.query({ id }),
    enabled: initial === "pending",
    retry: false,
    refetchInterval: (query) => ((query.state.data?.state ?? "pending") === "pending" ? 3000 : false),
  });
  const state = initial === "pending" ? data?.state ?? "pending" : initial;
  useEffect(() => {
    if (initial === "pending" && state === "ready") router.refresh();
  }, [initial, state, router]);
  return state;
}

/** The twin page: poll while any learner session's report is pending; refresh as each one lands. */
export function usePendingReports(slug: string, initialCount: number): number {
  const router = useRouter();
  const { data } = useQuery({
    queryKey: ["twin-pending-reports", slug],
    queryFn: () => twinClient.agents.pendingReports.query({ slug }),
    enabled: initialCount > 0,
    retry: false,
    refetchInterval: (query) => ((query.state.data?.count ?? initialCount) > 0 ? 5000 : false),
  });
  const count = initialCount > 0 ? data?.count ?? initialCount : 0;
  const last = useRef(count);
  useEffect(() => {
    if (count < last.current) router.refresh();
    last.current = count;
  }, [count, router]);
  return count;
}
