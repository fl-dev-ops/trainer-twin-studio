"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CreditsIcon } from "@/components/icons";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { DEFAULT_LEARNER_MINUTES } from "@/lib/minutes-config";
import { cn } from "@/lib/utils";

/** The sidebar's Credits link, with the org's remaining credits; amber when a new learner's minutes no longer fit. */
export function SidebarCredits({ active }: { active: boolean }) {
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
