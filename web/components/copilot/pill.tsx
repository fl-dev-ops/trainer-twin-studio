"use client";

import { useSyncExternalStore } from "react";
import { CopilotIcon } from "@/components/icons";
import { Kbd } from "@/components/ui/kbd";
import type { CopilotStatus } from "@/components/copilot/panel";
import { cn } from "@/lib/utils";

/**
 * The copilot's button: the website voice widget's resting button (widgets/src/widget.css `.tt-pill`,
 * `.tt-intro-button`) brought into the studio. An ink pill, 44px tall, a 16px icon and a 15px semibold label, with a
 * soft light wash on hover. It also says what the conversation is doing while the copilot is closed.
 */

const subscribe = () => () => {};
/** "⌘J" on a Mac, "Ctrl J" elsewhere; nothing on the server pass. */
export const useCopilotShortcut = () =>
  useSyncExternalStore(subscribe, () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘J" : "Ctrl J"), () => "");

export type PillTone = "caution" | "working" | "brand" | null;

/** What the button says: "Ask Copilot" at rest, otherwise what it's doing or waiting for. */
export function pillLabel(status: CopilotStatus, unread: boolean, activity: string): { text: string; tone: PillTone } {
  if (status === "needs-you") return { text: "Needs your approval", tone: "caution" };
  if (status === "working") return { text: `${activity}…`, tone: "working" };
  if (unread) return { text: "New reply", tone: "brand" };
  return { text: "Ask Copilot", tone: null };
}

/** The button's face: icon with its status, the words, and the shortcut on hover. */
export function CopilotPillFace({ text, tone, shortcut }: { text: string; tone: PillTone; shortcut?: string }) {
  return (
    <>
      <span className="relative grid shrink-0 place-items-center">
        <CopilotIcon className={cn("size-4", tone === "working" && "animate-copilot-breathe text-brand")} />
        {(tone === "caution" || tone === "brand") && (
          <span
            aria-hidden
            // Keyed by tone, so a reply after an approval pops in again rather than just changing colour.
            key={tone}
            className={cn(
              "animate-copilot-dot absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-foreground",
              tone === "caution" ? "bg-caution" : "bg-brand",
            )}
          />
        )}
      </span>
      {/* A new step settles in rather than swapping in place. */}
      <span key={text} className="animate-copilot-chip min-w-0 truncate">{text}</span>
      {shortcut && !tone && (
        // The shortcut is there when you reach for the button, not as permanent noise.
        <span aria-hidden className="ml-auto hidden opacity-0 transition-opacity duration-150 group-hover/pill:opacity-60 group-focus-visible/pill:opacity-60 md:flex">
          <Kbd>{shortcut}</Kbd>
        </span>
      )}
    </>
  );
}

/** The pill's look (shared by the docked layout's launcher and the floating shape's resting face). */
export const PILL_CLASS =
  "group/pill flex items-center gap-2 rounded-full bg-foreground py-2 pr-4 pl-3.5 text-body font-semibold text-background outline-none transition-colors hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * The launcher for the docked layout and phones: fixed at the bottom right, it steps aside (fades and sinks) while
 * the copilot is open, since the panel or sheet is then right there.
 */
export function CopilotLauncher({
  hidden,
  status,
  unread,
  activity,
  onOpen,
  onPrefetch,
}: {
  hidden: boolean;
  status: CopilotStatus;
  unread: boolean;
  activity: string;
  onOpen: () => void;
  onPrefetch: () => void;
}) {
  const shortcut = useCopilotShortcut();
  const { text, tone } = pillLabel(status, unread, activity);
  return (
    <button
      type="button"
      data-copilot-entry=""
      data-copilot-launcher=""
      data-state={hidden ? "hidden" : "shown"}
      inert={hidden}
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      aria-label={tone ? `Copilot: ${text}` : "Open Copilot"}
      aria-keyshortcuts="Meta+J Control+J"
      className={cn(PILL_CLASS, "fixed right-4 bottom-4 z-40 h-11 max-w-80 shadow-elevation-3 md:right-6 md:bottom-6")}
    >
      <CopilotPillFace text={text} tone={tone} shortcut={shortcut} />
    </button>
  );
}
