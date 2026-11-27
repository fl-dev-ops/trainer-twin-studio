"use client";

import { useSyncExternalStore } from "react";
import { CopilotIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { type CopilotStatus, useCopilotPanel } from "@/components/copilot/panel";
import { cn } from "@/lib/utils";

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const subscribe = () => () => {};
/** "⌘J" on a Mac, "Ctrl J" elsewhere; nothing on the server pass. */
function useShortcutLabel() {
  return useSyncExternalStore(subscribe, () => (isMac() ? "⌘J" : "Ctrl J"), () => "");
}

/** What the entry says about the conversation while the panel is closed (plans/copilot-everywhere.md, "Status"). */
function statusOf(status: CopilotStatus, unread: boolean, open: boolean) {
  if (open) return { label: "Close Copilot", tone: null };
  if (status === "needs-you") return { label: "Copilot, needs your approval", tone: "caution" as const };
  if (status === "working") return { label: "Copilot, working", tone: "working" as const };
  if (unread) return { label: "Copilot, new reply", tone: "brand" as const };
  return { label: "Open Copilot", tone: null };
}

/** The copilot's icon with its status: breathing while it works, a dot when it needs you or has replied. */
function StatusIcon({ tone, className }: { tone: "caution" | "working" | "brand" | null; className?: string }) {
  return (
    // `grid!` on the collapsed rail: it hides a nav item's direct <span> children (the label), and this one is the icon.
    <span className={cn("relative grid shrink-0 place-items-center group-data-[collapsible=icon]:grid!", className)}>
      <CopilotIcon className={cn(tone === "working" && "animate-copilot-breathe text-brand!")} />
      {(tone === "caution" || tone === "brand") && (
        <span
          aria-hidden
          // Keyed by tone, so a reply after an approval pops in again rather than just changing colour.
          key={tone}
          className={cn(
            "animate-copilot-dot absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
            tone === "caution" ? "bg-caution" : "bg-brand",
          )}
        />
      )}
    </span>
  );
}

/**
 * The Copilot item at the top of the rail: opens and closes the panel beside the page, shows its shortcut on hover and
 * what the conversation is doing while the panel is closed. On home, where the page is the copilot, it's the current
 * page and puts you in the composer.
 */
export function CopilotRailEntry() {
  const copilot = useCopilotPanel();
  const shortcut = useShortcutLabel();
  if (!copilot) return null;
  const { open, onHome, status, unread } = copilot;
  const { label, tone } = statusOf(status, unread, open);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          data-copilot-entry=""
          variant="nav"
          isActive={open || onHome}
          aria-current={onHome ? "page" : undefined}
          aria-expanded={onHome ? undefined : open}
          aria-controls={onHome ? undefined : "copilot-panel"}
          aria-label={onHome ? "Copilot" : label}
          aria-keyshortcuts="Meta+J Control+J"
          tooltip={shortcut ? `Copilot · ${shortcut}` : "Copilot"}
          onPointerEnter={copilot.prefetch}
          onFocus={copilot.prefetch}
          onClick={() => (onHome ? document.querySelector<HTMLTextAreaElement>("[data-copilot-composer] textarea")?.focus() : copilot.toggle())}
          className="group/copilot"
        >
          <StatusIcon tone={tone} />
          <span>Copilot</span>
          {shortcut && (
            // The shortcut is there when you reach for the item, not as permanent noise in the rail.
            <span
              aria-hidden
              className="ml-auto flex opacity-0 transition-opacity duration-150 group-hover/copilot:opacity-100 group-focus-visible/copilot:opacity-100 group-data-[collapsible=icon]:hidden"
            >
              <Kbd>{shortcut}</Kbd>
            </span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The phone's top bar: the rail is a drawer there, so the copilot gets its own button. */
export function CopilotTopBarButton() {
  const copilot = useCopilotPanel();
  if (!copilot || copilot.onHome) return null;
  const { label, tone } = statusOf(copilot.status, copilot.unread, copilot.open);
  return (
    <Button variant="ghost" iconOnly aria-label={label} onClick={copilot.toggle} onPointerEnter={copilot.prefetch} className="ml-auto">
      <StatusIcon tone={tone} className="[&_svg]:size-5" />
    </Button>
  );
}
