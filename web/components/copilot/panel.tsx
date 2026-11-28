"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { COPILOT_LAYOUT_COOKIE, COPILOT_OPEN_COOKIE, COPILOT_WIDTH_COOKIE, type CopilotLayout } from "@/components/copilot/cookies";
import { CopilotFloating } from "@/components/copilot/floating";
import { CopilotLauncher } from "@/components/copilot/pill";
import { useIsMobile } from "@/hooks/use-mobile";
import { seedCopilot } from "@/lib/copilot-handoff";
import { type CopilotOffRoute, isCopilotHome, isCopilotOff } from "@/lib/copilot-page";
import { dashRoute } from "@/lib/routes";

/**
 * The copilot beside every studio page (plans/copilot-everywhere.md): one docked panel on the right, mounted once in
 * the shell so a conversation survives navigation, and the state the rest of the studio reads (the rail's entry, the
 * handoffs, the full-page chat on home).
 */

const loadChat = () => import("@/components/copilot-chat");
const CopilotChat = dynamic(() => loadChat().then((module) => module.CopilotChat), {
  ssr: false,
  loading: () => <PanelLoading />,
});

/** The first open, while the chat's code arrives: the same frame the chat's own skeleton draws (CopilotPanelSkeleton). */
function PanelLoading() {
  return (
    <div aria-busy="true" aria-label="Loading Copilot" className="flex h-full min-h-0 flex-1 flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center px-3 text-sm font-medium sm:px-4">Copilot</div>
      <div className="mt-auto px-3 pb-4">
        <div className="mx-auto h-[7.25rem] max-w-2xl rounded-2xl border border-sidebar-border bg-background" />
      </div>
    </div>
  );
}

/** What the conversation is doing, as the rail shows it while the panel is closed. */
export type CopilotStatus = "idle" | "working" | "needs-you";

export const COPILOT_DEFAULT_WIDTH = 416; // 26rem
const MIN_WIDTH = 352; // 22rem
const MAX_WIDTH = 640; // 40rem
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const maxWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.45)));
const clampWidth = (width: number) => Math.round(Math.min(Math.max(width, MIN_WIDTH), typeof window === "undefined" ? MAX_WIDTH : maxWidth()));
const saveCookie = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
};

type CopilotPanelContext = {
  /** The panel is showing (the docked panel on desktop, the sheet on a phone). */
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** On home the full-page chat is the copilot; the panel steps aside. */
  onHome: boolean;
  /** On a page the copilot stays off (hiddenOn): nothing of it shows. */
  off: boolean;
  status: CopilotStatus;
  /** A reply finished while the panel was closed. */
  unread: boolean;
  /** Each mounted chat reports its conversation's status here, and what it's doing ("Listing twins"). */
  report: (status: CopilotStatus, activity?: string) => void;
  /** Docked beside the page, or floating over it in the corner (a per-person choice). */
  layout: CopilotLayout;
  setLayout: (layout: CopilotLayout) => void;
  /** Floating only: grown into the middle of the screen. */
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  /** The org runs role plays (twin-only orgs don't): what the copilot offers to start from. */
  roleplay: boolean;
  /** Start a new conversation with this message, in the panel, without leaving the page. */
  openWith: (text: string) => void;
  /** Load the chat's code ahead of the first open (hover or focus on an entry point). */
  prefetch: () => void;
  /** Bumped when the composer should take focus (opening, or ⌘J on home). */
  focusSignal: number;
};

const Context = createContext<CopilotPanelContext | null>(null);

/** The copilot panel's state; null outside the studio shell (full-screen flows), where there is no panel. */
export const useCopilotPanel = () => useContext(Context);

/**
 * Hand a request to the copilot: in the panel beside this page when there is one, else on the full page (home).
 * Either way it starts a new conversation with the message.
 */
export function useCopilotHandoff() {
  const copilot = useCopilotPanel();
  const router = useRouter();
  return useCallback((text: string) => {
    if (copilot && !copilot.onHome && !copilot.off) return copilot.openWith(text);
    seedCopilot(text);
    router.push(dashRoute("/"));
  }, [copilot, router]);
}

export function CopilotPanelProvider({
  children,
  defaultOpen = false,
  defaultWidth = COPILOT_DEFAULT_WIDTH,
  defaultLayout = "docked",
  roleplay = true,
  hiddenOn = [],
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  defaultWidth?: number;
  defaultLayout?: CopilotLayout;
  roleplay?: boolean;
  /**
   * Pages the copilot stays off (copilotOff in lib/copilot-page.ts): no button, no panel, ⌘J does nothing. Its open
   * state is kept, so it's back as it was on the next page.
   */
  hiddenOn?: readonly CopilotOffRoute[];
}) {
  const pathname = usePathname();
  const onHome = isCopilotHome(pathname);
  const off = isCopilotOff(pathname, hiddenOn);
  // Where there's no panel: home (the page is the copilot) and the pages it stays off.
  const away = onHome || off;
  const isMobile = useIsMobile();
  const [desktopOpen, setDesktopOpen] = useState(defaultOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const open = isMobile ? mobileOpen : desktopOpen;
  // The chat's code and conversation load on first open, then stay mounted while closed: a running job keeps
  // streaming, and the rail keeps showing what it's doing.
  const [mounted, setMounted] = useState(defaultOpen);
  const [chatKey, setChatKey] = useState(0);
  const [status, setStatus] = useState<CopilotStatus>("idle");
  const [unread, setUnread] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusSignal, setFocusSignal] = useState(0);
  const [layout, setLayoutState] = useState<CopilotLayout>(defaultLayout);
  const [expanded, setExpanded] = useState(false);
  const [activity, setActivity] = useState("Thinking");
  // The same start on the server and in the browser (no window here); the window clamps it after mount, below.
  const [width, setWidth] = useState(() => Math.round(Math.min(Math.max(defaultWidth, MIN_WIDTH), MAX_WIDTH)));
  const returnFocus = useRef<HTMLElement | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  // The latest state for callbacks and listeners. Updated in a layout effect: the chats' status effects run after it.
  const live = useRef({ open, onHome, off, status });
  useLayoutEffect(() => {
    live.current = { open, onHome, off, status };
  });

  // Leaving home while the copilot works or waits for you: bring the conversation along, so a running build never
  // drops out of sight. (Desktop only; on a phone the rail's entry shows the status instead of a sheet popping up.)
  // Arriving home: the full page shows the conversation, so nothing is unread any more.
  const [wasHome, setWasHome] = useState(onHome);
  if (wasHome !== onHome) {
    setWasHome(onHome);
    if (onHome) setUnread(false);
    else if (status !== "idle" && !isMobile && !off) {
      setMounted(true);
      setDesktopOpen(true);
    }
  }
  // Remembered for the next visit (app/dash/layout.tsx reads it on the server).
  useEffect(() => {
    saveCookie(COPILOT_OPEN_COOKIE, desktopOpen ? "1" : "0");
  }, [desktopOpen]);

  const setOpen = useCallback((next: boolean) => {
    if (next) {
      const active = document.activeElement;
      // Where focus goes back to on close; nothing focused (<body>) means the launcher.
      if (active instanceof HTMLElement && active !== document.body && !dock.current?.contains(active)) returnFocus.current = active;
      setMounted(true);
      setUnread(false);
      setFocusSignal((n) => n + 1);
    } else if (dock.current?.contains(document.activeElement)) {
      // Focus goes back where it came from, or to the launcher: never lost on <body>. A frame later, once the
      // launcher is no longer inert.
      const back = returnFocus.current;
      requestAnimationFrame(() => {
        const target = back?.isConnected ? back : document.querySelector<HTMLElement>("[data-copilot-entry]:not([inert])");
        target?.focus({ preventScroll: true });
      });
    }
    if (!next) setExpanded(false);
    if (window.matchMedia("(max-width: 767px)").matches) setMobileOpen(next);
    else setDesktopOpen(next);
  }, []);

  const setLayout = useCallback((next: CopilotLayout) => {
    setLayoutState(next);
    setExpanded(false);
    saveCookie(COPILOT_LAYOUT_COOKIE, next);
    // The conversation moves to its new home; keep the caret in it.
    setFocusSignal((n) => n + 1);
  }, []);

  const toggle = useCallback(() => setOpen(!live.current.open), [setOpen]);

  const report = useCallback((next: CopilotStatus, step?: string) => {
    if (step) setActivity((current) => (current === step ? current : step));
    const { open, onHome, status: before } = live.current;
    if (next === before) return;
    setStatus(next);
    const unseen = !open && !onHome;
    if (unseen && before !== "idle" && next === "idle") setUnread(true);
    if (unseen && next === "needs-you") setAnnouncement("Copilot needs your approval");
    else if (next !== "needs-you") setAnnouncement("");
  }, []);

  const openWith = useCallback((text: string) => {
    seedCopilot(text);
    // A fresh chat picks the queued message up and starts a new conversation with it (CopilotChat).
    setChatKey((key) => key + 1);
    setOpen(true);
  }, [setOpen]);

  const prefetch = useCallback(() => {
    void loadChat();
  }, []);

  // ⌘J / Ctrl+J anywhere in the studio: toggle the panel; on home, where the page is the copilot, focus its composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "j" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (event.repeat) return;
      if (live.current.onHome) setFocusSignal((n) => n + 1);
      else if (!live.current.off) toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  // The width follows the window: a panel resized on a wide screen never squeezes the page on a narrow one.
  useEffect(() => {
    const onResize = () => setWidth((current) => clampWidth(current));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const value = useMemo<CopilotPanelContext>(
    () => ({
      open: open && !away, setOpen, toggle, onHome, off, status, unread, report, openWith, prefetch, focusSignal,
      layout, setLayout, expanded, setExpanded, roleplay,
    }),
    [open, away, setOpen, toggle, onHome, off, status, unread, report, openWith, prefetch, focusSignal, layout, setLayout, expanded, roleplay],
  );

  // Never two chats on one conversation: on home the page's chat runs it and the panel's is unmounted.
  // On a page it stays off, the conversation is put away too; it resumes on the next page (it's saved per person).
  const chat = mounted && !away ? <CopilotChat key={chatKey} variant="panel" /> : null;

  return (
    <Context.Provider value={value}>
      {children}
      {isMobile ? (
        <Sheet open={mobileOpen && !away} onOpenChange={setOpen}>
          <SheetContent
            side="right"
            showCloseButton={false}
            borderless
            // Full screen on a phone: the sheet's own 3/4 width leaves a sliver of page too thin to use or read.
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:max-w-none"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Copilot</SheetTitle>
              <SheetDescription>Ask the copilot about this page, or build a twin skill or role play.</SheetDescription>
            </SheetHeader>
            <div className="flex h-full min-h-0 flex-col bg-sidebar">{chat}</div>
          </SheetContent>
        </Sheet>
      ) : away ? null : layout === "floating" ? (
        <CopilotFloating
          ref={dock}
          open={desktopOpen}
          expanded={expanded}
          status={status}
          unread={unread}
          activity={activity}
          onOpen={() => setOpen(true)}
          onFold={() => setExpanded(false)}
          onPrefetch={prefetch}
        >
          {chat}
        </CopilotFloating>
      ) : (
        <Dock ref={dock} open={desktopOpen} width={width} onWidth={setWidth}>
          {chat}
        </Dock>
      )}
      {/* The way in, bottom right: in the docked layout and on phones (floating has it built into its shape). */}
      {!away && (isMobile || layout === "docked") && (
        <CopilotLauncher
          hidden={open}
          status={status}
          unread={unread}
          activity={activity}
          onOpen={() => setOpen(true)}
          onPrefetch={prefetch}
        />
      )}
      <p aria-live="polite" className="sr-only">{announcement}</p>
    </Context.Provider>
  );
}

/**
 * The docked panel. The outer box animates its width, which pushes the page over; the panel inside keeps its full
 * width and rides the box's left edge, so the conversation slides in whole instead of reflowing every frame.
 */
function Dock({
  ref,
  open,
  width,
  onWidth,
  children,
}: {
  ref: React.Ref<HTMLDivElement>;
  open: boolean;
  width: number;
  onWidth: (width: number) => void;
  children: ReactNode;
}) {
  const [resizing, setResizing] = useState(false);
  const commit = (next: number) => {
    const clamped = clampWidth(next);
    onWidth(clamped);
    saveCookie(COPILOT_WIDTH_COOKIE, String(clamped));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    onWidth(clampWidth(window.innerWidth - event.clientX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    commit(window.innerWidth - event.clientX);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") commit(width + step);
    else if (event.key === "ArrowRight") commit(width - step);
    else if (event.key === "Home") commit(MIN_WIDTH);
    else if (event.key === "End") commit(MAX_WIDTH);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      data-copilot-dock=""
      data-state={open ? "open" : "closed"}
      data-resizing={resizing ? "" : undefined}
      className="relative hidden h-svh w-0 shrink-0 overflow-hidden data-[state=open]:w-(--copilot-width) md:block"
      style={{ "--copilot-width": `${width}px` } as CSSProperties}
    >
      <aside
        id="copilot-panel"
        aria-label="Copilot"
        inert={!open}
        className="absolute inset-y-0 left-0 flex w-(--copilot-width) flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Copilot"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={open ? 0 : -1}
          title="Drag to resize · double-click to reset"
          data-copilot-resize=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setResizing(false)}
          onDoubleClick={() => commit(COPILOT_DEFAULT_WIDTH)}
          onKeyDown={onKeyDown}
          className="group/resize absolute inset-y-0 -left-px z-30 w-2 cursor-col-resize touch-none outline-none"
        >
          <span aria-hidden className="copilot-resize-line absolute inset-y-0 left-0 w-px" />
        </div>
        <div data-copilot-body="" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </aside>
    </div>
  );
}
