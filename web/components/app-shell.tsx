"use client";

import type { CSSProperties, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
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

export function AppShell({ children, hideRoleplay = false }: { children: ReactNode; hideRoleplay?: boolean }) {
  const pathname = usePathname();

  if (
    FULLSCREEN.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.endsWith("/calibrate") ||
    pathname.includes("/calibrate/")
  ) {
    return children;
  }

  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      // Reference rail: 248px expanded / 72px collapsed.
      style={{ "--sidebar-width-left": "15.5rem", "--sidebar-width-icon": "4.5rem" } as CSSProperties}
    >
      <AppSidebar hideRoleplay={hideRoleplay} />
      {/* Prototype: flat content panel, flush against the rail (reference .main). */}
      <SidebarInset className="min-h-0 overflow-hidden bg-panel">
        {/* Desktop collapses via the sidebar logo; on mobile the sidebar is a drawer and needs an opener. */}
        <div className="flex h-12 shrink-0 items-center px-3 md:hidden">
          <SidebarTrigger />
        </div>
        <div className="flex min-h-0 flex-1 flex-col w-full overflow-hidden">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
