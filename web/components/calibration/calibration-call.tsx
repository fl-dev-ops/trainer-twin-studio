"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  ArrowUpRightIcon,
  CallEndedIcon,
  ChatIcon,
  CloseIcon,
  FeelsLikeMeIcon,
  FeelsOffIcon,
  HangUpIcon,
  MicIcon,
  PhoneIcon,
  SourceIcon,
  WhyIcon,
} from "@/components/calibration/call-icons";
import { DEMO_SCRIPT, DEMO_WHY, FEELS_OFF_FOLLOW_UP, type CalibrationTurn, type Rating } from "@/components/calibration/mock";
import { Bubble, CalibrationStats, PANEL_SHADOW, PILL, RatingLabel, SOFT_SHADOW, TwinPortrait } from "@/components/calibration/parts";
import { RoleplayIcon } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/** A turn in the call; `aside` turns (greeting, follow-up questions) aren't answers, so they can't be rated. */
type Turn = CalibrationTurn & { aside?: boolean };

const TURN_MS = 4500;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const CONTROL = "grid size-[54px] place-items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-[22px]";

/**
 * Calibration call (V2 prototype "Talk to my twin"): the trainer talks to their twin and rates each answer.
 * shortcut: plays DEMO_SCRIPT instead of a LiveKit call, wire to the session runtime once the backend exists.
 */
export function CalibrationCall({ slug, scenarioName, twinName }: { slug: string; scenarioName: string; twinName: string }) {
  const [phase, setPhase] = useState<"live" | "ended">("live");
  const [turns, setTurns] = useState<Turn[]>(() => [{ ...DEMO_SCRIPT[0], aside: true }]);
  const [next, setNext] = useState(1);
  const [speakingId, setSpeakingId] = useState<string | null>(DEMO_SCRIPT[0].id);
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [panel, setPanel] = useState<"conversation" | "why" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const live = phase === "live";

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

  // Demo: the next scripted line arrives every few seconds.
  useEffect(() => {
    if (!live || next >= DEMO_SCRIPT.length) return;
    const id = setTimeout(() => {
      const turn = DEMO_SCRIPT[next];
      setTurns((all) => [...all, turn]);
      if (turn.speaker === "twin") setSpeakingId(turn.id);
      setNext(next + 1);
    }, TURN_MS);
    return () => clearTimeout(id);
  }, [live, next]);

  useEffect(() => {
    if (!speakingId) return;
    const id = setTimeout(() => setSpeakingId(null), 3000);
    return () => clearTimeout(id);
  }, [speakingId]);

  function rate(turnId: string, rating: Rating) {
    setTurns((all) => {
      const rated = all.map((t) => (t.id === turnId ? { ...t, rating } : t));
      if (rating !== "off") return rated;
      // As in the prototype, "Feels off" makes the twin ask what was wrong.
      const followUp: Turn = { id: `${turnId}-why`, speaker: "twin", text: FEELS_OFF_FOLLOW_UP, aside: true };
      setSpeakingId(followUp.id);
      return [...rated, followUp];
    });
  }

  function restart() {
    setTurns([{ ...DEMO_SCRIPT[0], aside: true }]);
    setNext(1);
    setSpeakingId(DEMO_SCRIPT[0].id);
    setSeconds(0);
    setMuted(false);
    setPanel(null);
    setPhase("live");
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Link
        href="/agents"
        className="flex w-fit items-center gap-2 px-8 pt-6 text-sm text-foreground/90 hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Calibrate · {scenarioName}
      </Link>

      {live ? (
        <>
          {/* With a panel open, centre the call in the space left of it so the panel never covers the answer. */}
          <div className={cn("flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-8 pb-32", panel && "lg:pr-[440px]")}>
            <div className={cn("relative size-[320px] shrink-0 overflow-hidden rounded-[32px] bg-muted", SOFT_SHADOW)}>
              <TwinPortrait name={twinName} className="size-full text-8xl" />
              <span className="absolute bottom-3 left-3 rounded-full bg-white px-2.5 py-1 text-[13px] leading-[18px] font-medium text-neutral-900 shadow-[0_0_0_1px_#e9e9e9]">
                {twinName}
              </span>
              <span className="absolute right-3 bottom-3 rounded-full bg-black/45 px-2.5 py-1 text-[13px] leading-[18px] font-medium text-white tabular-nums">
                <span className="sr-only">Call time </span>
                {clock(seconds)}
              </span>
            </div>

            <Captions
              turns={turns.slice(-2)}
              twinName={twinName}
              speakingId={speakingId}
              onRate={rate}
              onWhy={() => setPanel("why")}
            />
          </div>

          <div className={cn("absolute inset-x-0 bottom-6 flex justify-center gap-4", panel && "lg:pr-[440px]")}>
            <button
              type="button"
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
              className={cn(CONTROL, muted ? "bg-foreground text-background" : "border bg-muted hover:bg-border")}
            >
              <MicIcon off={muted} />
            </button>
            <button
              type="button"
              aria-label="View conversation"
              aria-pressed={panel === "conversation"}
              onClick={() => setPanel(panel === "conversation" ? null : "conversation")}
              style={{ "--call-chat-lines": panel === "conversation" ? "var(--card)" : "var(--muted)" } as React.CSSProperties}
              className={cn(CONTROL, "border", panel === "conversation" ? "bg-card" : "bg-muted hover:bg-border")}
            >
              <ChatIcon />
            </button>
            <button
              type="button"
              aria-label="End call"
              onClick={() => setConfirmEnd(true)}
              className={cn(CONTROL, "bg-[#ce2c33] text-white hover:bg-[#b5262c]")}
            >
              <HangUpIcon />
            </button>
          </div>

          {panel === "conversation" ? (
            <ConversationPanel turns={turns} twinName={twinName} onClose={() => setPanel(null)} />
          ) : null}
          {panel === "why" ? <WhyPanel onClose={() => setPanel(null)} /> : null}

          <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
            <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-6 rounded-3xl px-6 pt-8 pb-6">
              <AlertDialogTitle className="max-w-[300px] text-center text-xl leading-7 font-semibold tracking-[-0.015em]">
                Do you want to end the conversation?
              </AlertDialogTitle>
              <div className="grid w-full grid-cols-2 gap-2">
                <button
                  type="button"
                  className={cn(PILL, "h-10 justify-center px-4 text-sm")}
                  onClick={() => {
                    setConfirmEnd(false);
                    setPanel(null);
                    setPhase("ended");
                  }}
                >
                  Yes, end the call
                </button>
                <AlertDialogCancel variant="default" className="h-10 rounded-full px-4 text-sm font-semibold">
                  No, I’ll continue
                </AlertDialogCancel>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <CallSummary
          slug={slug}
          twinName={twinName}
          seconds={seconds}
          turns={turns}
          onRestart={restart}
        />
      )}
    </div>
  );
}

/** The last couple of lines, live, with the rating buttons under the twin's latest answer. */
function Captions({
  turns,
  twinName,
  speakingId,
  onRate,
  onWhy,
}: {
  turns: Turn[];
  twinName: string;
  speakingId: string | null;
  onRate: (id: string, rating: Rating) => void;
  onWhy: () => void;
}) {
  return (
    <div aria-live="polite" className="mt-8 flex w-full max-w-[440px] flex-col gap-4">
      {turns.map((turn) =>
        turn.speaker === "you" ? (
          <Bubble key={turn.id} speaker="you" className="max-w-[440px]">
            {turn.text}
          </Bubble>
        ) : (
          <div key={turn.id} className="flex flex-col gap-2">
            {turn.id === speakingId ? (
              <p className="flex items-center gap-2 text-[13px] leading-[18px] font-medium text-foreground/75">
                <span aria-hidden className="size-2 animate-pulse rounded-full bg-[#ce2c33] ring-3 ring-[#ce2c33]/20" />
                {twinName} speaking
              </p>
            ) : null}
            <div className="relative">
              <Bubble speaker="twin">{turn.text}</Bubble>
              {!turn.aside ? (
                <button
                  type="button"
                  aria-label="Why did the twin say this?"
                  title="Why did the twin say this?"
                  onClick={onWhy}
                  className="absolute top-1/2 -right-10 grid size-8 -translate-y-1/2 place-items-center rounded-full text-foreground/80 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:hidden"
                >
                  <WhyIcon className="size-5" />
                </button>
              ) : null}
            </div>
            {turn.aside ? null : turn.rating ? (
              <RatingLabel rating={turn.rating} className="text-[13px]" />
            ) : (
              <div className="flex gap-2">
                <button type="button" className={PILL} onClick={() => onRate(turn.id, "like")}>
                  <FeelsLikeMeIcon className="size-4" />
                  Feels like me
                </button>
                <button type="button" className={PILL} onClick={() => onRate(turn.id, "off")}>
                  <FeelsOffIcon className="size-4" />
                  Feels off
                </button>
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

function PanelShell({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      className={cn(
        "absolute right-6 bottom-6 z-20 flex flex-col overflow-hidden rounded-2xl bg-card max-sm:inset-x-4 max-sm:w-auto",
        PANEL_SHADOW,
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Full transcript so far, in a floating panel (prototype "Conversation"). */
function ConversationPanel({ turns, twinName, onClose }: { turns: Turn[]; twinName: string; onClose: () => void }) {
  return (
    <PanelShell label="Conversation" className="h-[450px] max-h-[calc(100%-3rem)] w-[360px]">
      <header className="flex h-11 shrink-0 items-center justify-between bg-muted/60 px-4">
        <h2 className="text-base font-semibold tracking-[-0.015em]">Conversation</h2>
        <button
          type="button"
          aria-label="Close conversation"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-full outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <CloseIcon className="size-5" />
        </button>
      </header>
      <ol className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {turns.map((turn) => (
          <li key={turn.id} className={cn("flex flex-col gap-1.5", turn.speaker === "you" && "items-end")}>
            <span className="text-xs text-foreground/75">{turn.speaker === "you" ? "You" : twinName}</span>
            <Bubble speaker={turn.speaker} className="text-[15px] leading-[22px]">
              {turn.text}
            </Bubble>
            {turn.rating ? <RatingLabel rating={turn.rating} /> : null}
          </li>
        ))}
      </ol>
    </PanelShell>
  );
}

/** "Why this answer": the twin's reasoning and the course sources it used. */
function WhyPanel({ onClose }: { onClose: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const sources = showAll ? DEMO_WHY.sources : DEMO_WHY.sources.slice(0, 3);
  return (
    <PanelShell label="Why this answer" className="max-h-[min(600px,calc(100%-3rem))] w-[400px] overflow-y-auto p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-card shadow-[0_0_0_1px_var(--border)] outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <CloseIcon className="size-4" />
      </button>
      <span className="grid size-14 shrink-0 place-items-center rounded-[18px] bg-card shadow-[0_0_0_1px_var(--border),0_2px_6px_rgba(30,28,25,0.08)]">
        <WhyIcon className="size-6" />
      </span>
      <h2 className="mt-4 pr-8 text-xl leading-7 font-semibold tracking-[-0.015em]">Why this answer</h2>
      <p className="mt-2 text-sm leading-[22px] text-foreground/75">{DEMO_WHY.summary}</p>
      <h3 className="mt-6 flex items-center gap-2 text-sm font-medium">
        Sources from your course
        <span className="rounded-full bg-muted px-2 text-xs leading-5 font-normal text-foreground/75">{DEMO_WHY.total}</span>
      </h3>
      <ul className="mt-3 flex flex-col gap-2">
        {sources.map((source) => (
          <li key={source.title} className="flex gap-3 rounded-xl bg-muted/70 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-foreground/75">
              <SourceIcon kind={source.kind} className="size-[18px]" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm leading-5 font-medium">{source.title}</span>
              <span className="text-[13px] leading-[18px] text-foreground/75">{source.meta}</span>
            </span>
          </li>
        ))}
      </ul>
      {!showAll && DEMO_WHY.sources.length > 3 ? (
        <button type="button" className={cn(PILL, "mt-3 w-fit px-3")} onClick={() => setShowAll(true)}>
          Show more
        </button>
      ) : null}
    </PanelShell>
  );
}

/** After the call: how long you spoke and how the answers were rated. */
function CallSummary({
  slug,
  twinName,
  seconds,
  turns,
  onRestart,
}: {
  slug: string;
  twinName: string;
  seconds: number;
  turns: Turn[];
  onRestart: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-20 pb-10">
      <p className="flex items-center gap-2 rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-foreground/75">
        <CallEndedIcon className="size-[18px]" />
        Call ended
      </p>
      <TwinPortrait name={twinName} className={cn("mt-6 size-60 rounded-[48px] text-7xl", SOFT_SHADOW)} />
      <h1 className="mt-6 text-lg font-semibold">{twinName}</h1>
      <p className="mt-0.5 text-sm text-foreground/75">Time spoke {clock(seconds)}</p>
      <Link
        href={`/agents/${encodeURIComponent(slug)}/calibrations/demo`}
        className="mt-5 flex items-center gap-1.5 text-sm font-medium text-foreground/75 hover:text-foreground"
      >
        View transcript
        <ArrowUpRightIcon className="size-4" />
      </Link>
      <div className="mt-6 w-full max-w-[560px]">
        <CalibrationStats turns={turns} />
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={onRestart}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <PhoneIcon className="size-[18px]" />
          Speak again
        </button>
        <Link href="/agents" className={cn(PILL, "h-10 px-4 text-sm")}>
          <RoleplayIcon className="size-[18px]" />
          Go to Roleplay
        </Link>
      </div>
    </div>
  );
}
