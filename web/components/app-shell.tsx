"use client";

import type { CSSProperties, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import type { CopilotLayout } from "@/components/copilot/cookies";
import { CopilotPanelProvider } from "@/components/copilot/panel";
import type { SwitchableOrg } from "@/components/org-switcher";
import { LoadingTable } from "@/components/page-skeletons";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

/** Dash pages that render without the studio chrome. */
const FULLSCREEN = [
  "/voice/cloning",
  "/dash/voice/cloning",
  "/twin/brain/voice",
  "/dash/twin/brain/voice",
  "/twin/brain/avatar",
  "/dash/twin/brain/avatar",
  "/talk",
  "/dash/talk",
  "/calibration",
  "/dash/calibration",
];

const isFullscreen = (pathname: string) =>
  FULLSCREEN.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
  pathname.endsWith("/calibrate") ||
  pathname.includes("/calibrate/");

/**
 * What the dash shows before the page hydrates (pages render only in the browser): the common page skeleton, or
 * nothing on full-screen routes, whose own loading.tsx takes over a moment later.
 */
export function ShellFallback() {
  return isFullscreen(usePathname()) ? null : <LoadingTable />;
}

export function AppShell({ children, hideRoleplay = false, bots = false, orgs = [], orgId = null, copilot }: {
  children: ReactNode;
  /** The copilot panel as this person left it (cookies read by the layout), so a reload doesn't animate it open. */
  copilot?: { open: boolean; width?: number; layout?: CopilotLayout };
  hideRoleplay?: boolean;
  /** The org may use bots (org metadata flag). */
  bots?: boolean;
  /** The studio orgs this person can switch between, and the one this page is in. */
  orgs?: SwitchableOrg[];
  orgId?: string | null;
}) {
  const pathname = usePathname();

  if (isFullscreen(pathname)) return children;

  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={{ "--sidebar-width-left": "18rem" } as CSSProperties}
    >
      {/* The copilot sits beside every page (components/copilot/panel.tsx): its dock is the row's last column. */}
      <CopilotPanelProvider defaultOpen={copilot?.open} defaultWidth={copilot?.width} defaultLayout={copilot?.layout} roleplay={!hideRoleplay}>
        <AppSidebar hideRoleplay={hideRoleplay} bots={bots} orgs={orgs} orgId={orgId} />
        {/* Prototype: flat content panel, flush against the rail (reference .main). */}
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          {/* Desktop collapses via the sidebar logo; on mobile the sidebar is a drawer and needs an opener. */}
          <div className="flex h-12 shrink-0 items-center px-3 md:hidden">
            <SidebarTrigger />
          </div>
          <div className="flex min-h-0 flex-1 flex-col w-full overflow-hidden">{children}</div>
        </SidebarInset>
      </CopilotPanelProvider>
    </SidebarProvider>
  );
}
