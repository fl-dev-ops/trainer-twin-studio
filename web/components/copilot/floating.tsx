"use client";

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { type ReactNode, type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import type { CopilotStatus } from "@/components/copilot/panel";
import { CopilotPillFace, PILL_CLASS, pillLabel, useCopilotShortcut } from "@/components/copilot/pill";
import { cn } from "@/lib/utils";

/**
 * The floating copilot (plans/copilot-everywhere.md, "Phase 1b"): one shape that reshapes between a pill resting in the
 * corner, an open card, and an expanded view in the middle of the screen. Position, size and corner radius move
 * together on the studio curve, so the pill *becomes* the card rather than a card appearing over it.
 */

type Shape = "pill" | "open" | "expanded";

const INSET = 24;
const PILL_H = 44;
const PILL_MIN = 148;
const PILL_MAX = 320;
const OPEN_W = 400;
const OPEN_H = 640;
const EASE = [0.16, 1, 0.3, 1] as const;

function geometry(shape: Shape, pillW: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (shape === "pill") return { w: pillW, h: PILL_H, x: vw - INSET - pillW, y: vh - INSET - PILL_H, r: PILL_H / 2 };
  if (shape === "open") {
    const w = Math.min(OPEN_W, vw - INSET * 2);
    const h = Math.min(OPEN_H, vh - INSET * 2);
    return { w, h, x: vw - INSET - w, y: vh - INSET - h, r: 20 };
  }
  const w = Math.min(760, vw - 64);
  const h = Math.min(Math.round(vh * 0.84), 860);
  return { w, h, x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), r: 24 };
}

export function CopilotFloating({
  ref,
  open,
  expanded,
  status,
  unread,
  activity,
  onOpen,
  onFold,
  onPrefetch,
  children,
}: {
  ref: Ref<HTMLDivElement>;
  open: boolean;
  expanded: boolean;
  status: CopilotStatus;
  unread: boolean;
  activity: string;
  onOpen: () => void;
  /** The backdrop behind the expanded view: fold back down to the card. */
  onFold: () => void;
  onPrefetch: () => void;
  children: ReactNode;
}) {
  const shape: Shape = !open ? "pill" : expanded ? "expanded" : "open";
  const reduce = useReducedMotion();
  const shortcut = useCopilotShortcut();
  const label = pillLabel(status, unread, activity);

  // The pill fits its words: measured from a hidden copy, so a longer step ("Listing knowledge files…") widens it smoothly.
  const measure = useRef<HTMLSpanElement>(null);
  const [pillW, setPillW] = useState(PILL_MIN);
  useLayoutEffect(() => {
    const natural = measure.current?.offsetWidth ?? PILL_MIN;
    setPillW(Math.min(PILL_MAX, Math.max(PILL_MIN, natural)));
  }, [label.text, shortcut]);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const w = useMotionValue(PILL_MIN);
  const h = useMotionValue(PILL_H);
  const r = useMotionValue(PILL_H / 2);
  // Handed to CSS as custom properties (the classes below read them), in px.
  const px = (value: number) => `${value}px`;
  const vars = {
    "--fx": useTransform(x, px), "--fy": useTransform(y, px), "--fw": useTransform(w, px),
    "--fh": useTransform(h, px), "--fr": useTransform(r, px),
  };
  const first = useRef(true);

  const place = useCallback((animated: boolean) => {
    const target = geometry(shape, pillW);
    const growing = shape !== "pill";
    // Opening settles slowly; folding away is quicker, so the page is back in your hands sooner.
    if (!animated || reduce) {
      x.set(target.x); y.set(target.y); w.set(target.w); h.set(target.h); r.set(target.r);
      return () => {};
    }
    const transition = { duration: growing ? 0.52 : 0.36, ease: EASE };
    const runs = [animate(x, target.x, transition), animate(y, target.y, transition), animate(w, target.w, transition),
      animate(h, target.h, transition), animate(r, target.r, transition)];
    return () => runs.forEach((run) => run.stop());
  }, [shape, pillW, reduce, x, y, w, h, r]);

  // First paint lands in place without flying in from the top-left; every change after that animates.
  useLayoutEffect(() => {
    const stop = place(!first.current);
    first.current = false;
    return stop;
  }, [place]);

  useEffect(() => {
    const onResize = () => place(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [place]);

  return (
    <>
      {/* Behind the expanded view the page goes soft; a click folds the copilot back to its card. */}
      <div
        aria-hidden
        onClick={onFold}
        data-copilot-backdrop=""
        data-state={shape === "expanded" ? "open" : "closed"}
        className="fixed inset-0 z-40 hidden bg-scrim/40 backdrop-blur-xs md:block"
      />
      <motion.div
        ref={ref}
        id="copilot-panel"
        role={open ? "dialog" : undefined}
        aria-label={open ? "Copilot" : undefined}
        aria-modal={shape === "expanded" || undefined}
        data-copilot-floating=""
        data-shape={shape}
        className="fixed top-0 left-0 z-40 hidden h-(--fh) w-(--fw) translate-x-(--fx) translate-y-(--fy) overflow-hidden rounded-(--fr) shadow-elevation-3 md:block"
        style={vars as unknown as React.CSSProperties}
      >
        {/* The resting pill: the same button as the docked layout's launcher (components/copilot/pill.tsx). */}
        <button
          type="button"
          data-copilot-pill=""
          data-copilot-entry=""
          inert={open}
          onClick={onOpen}
          onPointerEnter={onPrefetch}
          onFocus={onPrefetch}
          aria-label={label.tone ? `Copilot: ${label.text}` : "Open Copilot"}
          aria-keyshortcuts="Meta+J Control+J"
          className={cn(PILL_CLASS, "absolute inset-0 focus-visible:ring-inset focus-visible:ring-offset-0")}
        >
          <CopilotPillFace text={label.text} tone={label.tone} shortcut={shortcut} />
        </button>
        {/* Off-screen twin of the pill's contents, for its natural width. */}
        <span ref={measure} aria-hidden className="invisible absolute flex items-center gap-2 pr-4 pl-3.5 text-body font-semibold whitespace-nowrap">
          <span className="size-4" />
          {label.text}
          {shortcut && !label.tone && <Kbd>{shortcut}</Kbd>}
        </span>
        {/* The conversation: anchored bottom-right while the shape grows from the pill, so the composer arrives first. */}
        <div
          data-copilot-card=""
          inert={!open}
          className="absolute right-0 bottom-0 flex h-full min-h-[min(640px,calc(100vh-48px))] w-full min-w-[min(400px,calc(100vw-48px))] flex-col bg-sidebar text-sidebar-foreground"
        >
          {children}
        </div>
      </motion.div>
    </>
  );
}
