"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditsIcon } from "@/components/icons";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { DEFAULT_LEARNER_MINUTES } from "@/lib/minutes-config";
import { cn } from "@/lib/utils";

/** How often the studio checks whether the org's credits changed (minutes.version: a database read, no Meteroid call). */
const CHECK_EVERY_MS = 5_000;
/** Everything that shows credit numbers: reloaded when they change. */
const CREDIT_QUERIES = ["minutes.org", "page.credits", "minutes.learner", "page.users"];

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

/** The sidebar's Credits link, with the org's remaining credits; amber when a new learner's minutes no longer fit. */
export function SidebarCredits({ active }: { active: boolean }) {
  useLiveCredits();
  const { data } = useQuery({ queryKey: ["minutes.org"], queryFn: () => api.minutes.org.query(), staleTime: 60_000 });
  const low = data ? data.balanceMinutes < DEFAULT_LEARNER_MINUTES : false;
  const left = data ? `${data.balanceMinutes.toLocaleString()} min` : null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link href="/credits" />}
        isActive={active}
        tooltip={left ? `Credits · ${left} left` : "Credits"}
        variant="nav"
      >
        <CreditsIcon />
        <span>Credits</span>
        {left ? (
          <span className={cn("ml-auto text-xs tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden", low && "font-medium text-caution")}>
            {left}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
