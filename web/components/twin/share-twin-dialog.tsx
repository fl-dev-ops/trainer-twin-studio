"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { twinClient } from "@/lib/twin/client";
import { cn } from "@/lib/utils";

/** Reference share glyph (16px grid). */
function ShareGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-5" aria-hidden>
      <circle cx="11.25" cy="3.75" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.75" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.25" cy="12.25" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.1 7.2 9.9 4.7M6.1 8.8l3.8 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden>
      <path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" />
      <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden>
      <path d="M5 12l5 5l10 -10" />
    </svg>
  );
}

/**
 * Share popup (reference `botShareDialog`): the twin's /t/ link with Copy. The link opens only for learners
 * assigned to the twin, so sharing it grants no access by itself.
 */
export function ShareTwinDialog({
  open,
  onOpenChange,
  slug,
  name,
  allSkills,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  name: string;
  allSkills: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ["twin-share-link", slug],
    queryFn: () => twinClient.agents.shareLink.mutate({ slug }),
    enabled: open,
    staleTime: Infinity,
    retry: 2,
  });
  const url = data?.url ?? "";

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied. Only learners assigned to this twin can open it.");
    } catch {
      toast.error("Could not copy. Select the link and copy it.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-[rgb(11_10_9/0.55)] supports-backdrop-filter:backdrop-blur-none" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 duration-100",
          )}
        >
          {/* Reference .confirm-card */}
          <div className="relative flex w-full flex-col items-start gap-5 rounded-[24px] border-4 border-card bg-[linear-gradient(180deg,var(--sidebar)_0%,var(--card)_100%)] p-6 text-foreground shadow-[0_4px_8px_rgb(30_28_25/0.2)]">
            {/* Reference .confirm-tile */}
            <span aria-hidden className="flex rounded-[18px] bg-[linear-gradient(180deg,var(--border),var(--card))] p-[2px]">
              <span className="flex rounded-[16px] border-4 border-card bg-[linear-gradient(180deg,var(--sidebar),var(--card))] p-3 text-foreground shadow-[0_4px_8px_rgb(30_28_25/0.2),inset_0_0_4px_rgb(30_28_25/0.05)]">
                <ShareGlyph />
              </span>
            </span>

            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute top-3 right-3 grid size-8 place-items-center rounded-full text-foreground outline-none transition-colors hover:bg-(--tone-control) focus-visible:ring-2 focus-visible:ring-(--brand)"
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </DialogPrimitive.Close>

            <div className="flex flex-col gap-2">
              <DialogPrimitive.Title className="m-0 text-[20px] leading-7 font-semibold">Share {name}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="m-0 text-sm leading-5 text-(--text-secondary)">
                {allSkills
                  ? "Send this link to your learners so they can talk to your twin."
                  : "Send this link to your learners so they can ask the bot."}
              </DialogPrimitive.Description>
            </div>

            <div className="flex w-full flex-col gap-2">
              <label htmlFor="share-link" className="text-sm font-medium">
                Distribution link
              </label>
              <div className="flex gap-2">
                <input
                  id="share-link"
                  readOnly
                  value={url}
                  placeholder="Preparing link\u2026"
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-10 min-w-0 flex-1 rounded-[8px] border border-(--border) bg-card px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-(--brand) focus:ring-1 focus:ring-(--brand)"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  disabled={!url}
                  className={cn(
                    "inline-flex h-10 min-w-32 shrink-0 items-center justify-center gap-2 rounded-full bg-card px-4 text-sm font-normal outline-none transition-colors disabled:opacity-60",
                    "shadow-[0_0_1px_rgb(0_0_0/0.4),0_1px_1px_rgb(0_0_0/0.04),0_2px_4px_rgb(0_0_0/0.04)] hover:bg-(--sidebar) focus-visible:ring-2 focus-visible:ring-(--brand) dark:shadow-[0_0_0_1px_var(--border)]",
                    copied ? "text-(--brand)" : "text-foreground",
                  )}
                >
                  {copied ? <CheckGlyph /> : <CopyGlyph />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
