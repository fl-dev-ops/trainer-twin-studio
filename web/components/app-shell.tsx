"use client";

import dynamic from "next/dynamic";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const CopilotChat = dynamic(
  () =>
    import("@/components/copilot-chat").then((module) => module.CopilotChat),
  { ssr: false },
);

/** Dash pages that render without the studio chrome. */
const FULLSCREEN = ["/voice/cloning", "/dash/voice/cloning", "/talk", "/dash/talk"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotMounted, setCopilotMounted] = useState(false);

  if (FULLSCREEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return children;
  }

  const copilotPage = pathname === "/";

  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      rightOpen={copilotOpen}
      onRightOpenChange={(open) => {
        if (open) setCopilotMounted(true);
        setCopilotOpen(open);
      }}
      style={{ "--sidebar-width-right": "26rem" } as CSSProperties}
    >
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden bg-card">
        {!copilotPage && (
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
            <SidebarTrigger />
            <SidebarTrigger
              side="right"
              className="ml-auto w-auto px-3"
              aria-controls="copilot-panel"
              onClick={() => setCopilotMounted(true)}
            >
              Copilot
            </SidebarTrigger>
            <ThemeToggle />
          </header>
        )}
        <div className="flex min-h-0 flex-1">{children}</div>
      </SidebarInset>
      {!copilotPage && copilotMounted && (
        <CopilotChat variant="panel" onExpand={() => setCopilotOpen(false)} />
      )}
    </SidebarProvider>
  );
}
