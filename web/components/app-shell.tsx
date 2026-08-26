"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/** Dash pages that render without the studio chrome. */
const FULLSCREEN = ["/voice/cloning", "/talk"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (FULLSCREEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return children;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </SidebarProvider>
  );
}
