"use client";

import type { CSSProperties, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

/** Dash pages that render without the studio chrome. */
const FULLSCREEN = ["/voice/cloning", "/dash/voice/cloning", "/talk", "/dash/talk"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (FULLSCREEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return children;
  }

  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={{ "--sidebar-width-left": "15.5rem", "--sidebar-width-icon": "3.5rem" } as CSSProperties}
    >
      <AppSidebar />
      {/* Prototype: content panel sits flush to the right edge, rounded only toward the rail. */}
      <SidebarInset className="min-h-0 overflow-hidden bg-panel md:peer-data-[variant=inset]:my-0 md:peer-data-[variant=inset]:mr-0 md:peer-data-[variant=inset]:rounded-l-2xl md:peer-data-[variant=inset]:rounded-r-none md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0">
        {/* Desktop collapses via the sidebar logo; on mobile the sidebar is a drawer and needs an opener. */}
        <div className="flex h-12 shrink-0 items-center px-3 md:hidden">
          <SidebarTrigger />
        </div>
        <div className="flex min-h-0 flex-1">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
