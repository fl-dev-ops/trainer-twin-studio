"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Flag, Star } from "lucide-react";
import { toast } from "sonner";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { CalibrationCall, type CallResult } from "@/components/calibration/calibration-call";
import { CallEndedIcon, PhoneIcon } from "@/components/calibration/call-icons";
import { Bubble, PILL, TwinPortrait } from "@/components/calibration/parts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/** The signed-in person's access to this twin (null: signed out). */
export type LearnerAccess =
  | { ok: true; name: string; email: string; code: string; minutesLeft: number; minutesTotal: number }
  | { ok: false; name: string; email: string; reason: string }
  | null;

type Trainer = { name: string; title: string | null; photoUrl: string | null };
type Twin = { slug: string; name: string; description: string | null };
type Step = "landing" | "signin" | "check" | "call" | "summary";

// The dash's own scale (twin overview cards): 16px cards with the soft shadow, 11px labels, 18px titles, 15px body.
const CARD = "rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";
const LABEL = "m-0 text-[11px] font-medium tracking-[0.08em] uppercase";
const TITLE = "m-0 text-[18px] leading-7 font-semibold tracking-[-0.015em]";
const BODY = "m-0 text-[15px] leading-6 text-(--text-secondary)";
const BRAND = "h-10 w-full bg-(--brand) px-4 text-sm font-semibold text-white hover:bg-[#e04d00]";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const firstName = (name: string) => name.split(/[\s@]/)[0] || name;
const ISSUES = ["Wrong or made-up answer", "Didn't understand me", "Audio or connection", "Too slow", "Something else"];

/**
 * A learner's whole visit on a twin link, on one page (reference learner flow): what the twin is → sign in with Google
 * (back to this page) → their minutes → the call (the calibration screen, learner mode) → summary with a rating, a
 * problem report and the transcript. Never sends people to the auth pages.
 */
export function TwinLearnerFlow({ path, trainer, twin, access, startAtAccess = false }: { path: string; trainer: Trainer; twin: Twin; access: LearnerAccess; startAtAccess?: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(startAtAccess ? "check" : "landing");
  const [result, setResult] = useState<CallResult | null>(null);
  const [reportFor, setReportFor] = useState<{ sessionId: string | null } | null>(null);
  const minutesLeft = access?.ok ? access.minutesLeft : null;

  // Same row as a dash page header (min-h-10, 1024px column): the trainer on the left, minutes on the right.
  const header = (
    <header className="mx-auto flex min-h-10 w-full max-w-[560px] items-center justify-between gap-3 px-4 pt-5 md:px-0">
      <span className="flex min-w-0 items-center gap-2.5">
        <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="size-8 shrink-0 rounded-full text-xs" />
        <span className="flex min-w-0 flex-col">
          <b className="truncate text-sm leading-5 font-semibold">{trainer.name}</b>
          {trainer.title ? <small className="truncate text-xs leading-4 text-muted-foreground">{trainer.title}</small> : null}
        </span>
      </span>
      {minutesLeft !== null && step !== "landing" && step !== "signin" ? (
        <span className="shrink-0 rounded-full bg-(--tone-control) px-3 py-1 text-xs font-medium tabular-nums">{minutesLeft} min left</span>
      ) : null}
    </header>
  );

  function signOutAndRestart() {
    void authClient.signOut().finally(() => {
      setStep("signin");
      router.refresh();
    });
  }

  const report = reportFor ? <ReportDialog twin={twin} sessionId={reportFor.sessionId} onClose={() => setReportFor(null)} /> : null;

  if (step === "call" && access?.ok) {
    return (
      <>
        <CalibrationCall
          slug={twin.slug}
          scenarioName={twin.name}
          twinName={twin.name}
          twin
          photoUrl={trainer.photoUrl}
          learner={{
            code: access.code,
            minutesLeft: access.minutesLeft,
            header,
            onReport: (sessionId) => setReportFor({ sessionId }),
            onEnded: (ended) => {
              setResult(ended);
              setStep("summary");
              router.refresh(); // minutes left from the server for the summary and the next call
            },
          }}
        />
        {report}
      </>
    );
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      {header}
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 pt-10 pb-16 md:px-0">
        {step === "landing" ? (
          <article className={cn(CARD, "flex flex-col")}>
            <TwinHeading trainer={trainer} twin={twin} />
            {twin.description ? (
              <div className="mt-6">
                <p className={cn(LABEL, "text-muted-foreground")}>What it does</p>
                <p className={cn(BODY, "mt-1 line-clamp-5")}>{twin.description}</p>
              </div>
            ) : null}
            <Button className={cn(BRAND, "mt-6")} onClick={() => setStep(access ? "check" : "signin")}>
              <PhoneIcon className="size-[18px]" />
              Start conversation
            </Button>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Conversations are recorded to help you and {firstName(trainer.name)}.
            </p>
          </article>
        ) : step === "signin" ? (
          <article className={cn(CARD, "flex flex-col")}>
            <p className={cn(LABEL, "text-muted-foreground")}>Sign in</p>
            <h1 className={cn(TITLE, "mt-1")}>Who&apos;s practising?</h1>
            <p className={cn(BODY, "mt-1")}>Use the Google account {firstName(trainer.name)} invited, so your minutes and sessions are yours.</p>
            <div className="mt-6">
              <GoogleSignInButton callbackURL={`${typeof window === "undefined" ? "" : window.location.origin}${path}?start=1`} className="h-10 w-full text-sm" />
            </div>
            <Button variant="ghost" className="mt-2 h-9 self-center" onClick={() => setStep("landing")}>Back</Button>
          </article>
        ) : step === "check" && access ? (
          <article className={cn(CARD, "flex flex-col")}>
            <TwinHeading trainer={trainer} twin={twin} />
            {access.ok ? (
              <>
                {/* The twin overview's Usage credit box, for this person. */}
                <div className="mt-6 flex flex-col gap-2 rounded-[12px] bg-(--sidebar) p-5">
                  <p className={cn(LABEL, "text-emerald-700 dark:text-emerald-400")}>You&apos;re in, {firstName(access.name)}</p>
                  <p className="m-0 text-[20px] leading-6 font-semibold tabular-nums">
                    {access.minutesLeft} <span className="text-sm font-normal text-muted-foreground">of {access.minutesTotal} min left</span>
                  </p>
                  <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-card">
                    <span className="block h-full rounded-full bg-(--foreground)" style={{ width: `${Math.min(100, Math.round((access.minutesLeft / Math.max(1, access.minutesTotal)) * 100))}%` }} />
                  </span>
                  <p className="m-0 text-xs text-muted-foreground">Minutes count for the whole conversation, from start to end.</p>
                </div>
                <Button className={cn(BRAND, "mt-6")} disabled={access.minutesLeft <= 0} onClick={() => setStep("call")}>
                  <PhoneIcon className="size-[18px]" />
                  Start voice call
                </Button>
                <p className="mt-3 text-center text-xs text-muted-foreground">We&apos;ll ask for your microphone.</p>
              </>
            ) : (
              <div className="mt-6 flex flex-col gap-1.5 rounded-[12px] bg-amber-500/10 p-5 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                <p className={LABEL}>Not available</p>
                <p className="m-0 text-[15px] leading-6 font-medium">{access.reason}.</p>
                <p className="m-0 text-xs opacity-80">Signed in as {access.email}. Ask {firstName(trainer.name)} for access, or use the account they invited.</p>
              </div>
            )}
            <Button variant="ghost" className="mt-2 h-9 self-center text-muted-foreground" onClick={signOutAndRestart}>Use a different account</Button>
          </article>
        ) : step === "summary" && result ? (
          <Summary
            twin={twin}
            trainer={trainer}
            result={result}
            minutesLeft={minutesLeft}
            onReport={() => setReportFor({ sessionId: result.sessionId })}
            onAgain={() => setStep("check")}
          />
        ) : (
          <article className={CARD}>
            <TwinHeading trainer={trainer} twin={twin} />
          </article>
        )}
      </main>
      {report}
    </div>
  );
}

/** The twin's photo, kind and name, as at the top of each card. */
function TwinHeading({ trainer, twin }: { trainer: Trainer; twin: Twin }) {
  return (
    <div className="flex items-center gap-4">
      <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="size-16 shrink-0 rounded-[16px] text-2xl" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={cn(LABEL, "text-(--brand)")}>Twin · voice call</p>
        <h1 className={cn(TITLE, "line-clamp-2")} title={twin.name}>{twin.name}</h1>
      </div>
    </div>
  );
}

/** After the call (reference learnerSummary): minutes, a 1–5 rating with a note, report a problem, transcript. */
function Summary({ twin, trainer, result, minutesLeft, onReport, onAgain }: {
  twin: Twin;
  trainer: Trainer;
  result: CallResult;
  minutesLeft: number | null;
  onReport: () => void;
  onAgain: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const used = Math.max(1, Math.ceil(result.seconds / 60));

  async function send() {
    if (!rating || !result.sessionId) return;
    setSending(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(result.sessionId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, note: note.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not send your rating");
      setSent(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send your rating");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <article className={cn(CARD, "flex flex-col")}>
        <p className="m-0 flex w-fit items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground/75">
          <CallEndedIcon className="size-4" />
          Call ended
        </p>
        <h1 className={cn(TITLE, "mt-3")}>Conversation complete</h1>
        <p className="m-0 text-sm text-muted-foreground">{twin.name}</p>
        {/* The twin overview's stat tiles. */}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="rounded-[12px] bg-emerald-500/10 p-4 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
            <p className={LABEL}>This session</p>
            <p className="mt-2 mb-0 text-2xl font-semibold tabular-nums">{used} min</p>
            <p className="m-0 text-xs opacity-80 tabular-nums">{clock(result.seconds)} talked</p>
          </div>
          <div className="rounded-[12px] bg-(--sidebar) p-4">
            <p className={cn(LABEL, "text-muted-foreground")}>Minutes left</p>
            <p className="mt-2 mb-0 text-2xl font-semibold tabular-nums">{minutesLeft ?? "—"}</p>
            <p className="m-0 text-xs text-muted-foreground">with this twin</p>
          </div>
        </div>
        <Button className={cn(BRAND, "mt-6")} onClick={onAgain} disabled={minutesLeft !== null && minutesLeft <= 0}>
          <PhoneIcon className="size-[18px]" />
          Start another
        </Button>
      </article>

      <section className={cn(CARD, "flex flex-col")}>
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">How helpful was this?</h2>
        <p className="m-0 text-sm text-muted-foreground">Only {firstName(trainer.name)}&apos;s team sees your rating.</p>
        <div role="radiogroup" aria-label="Rating" className="mt-4 flex gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              disabled={sent}
              onClick={() => setRating(n)}
              className={cn(PILL, "size-10 justify-center px-0 disabled:opacity-60", n <= rating && "text-amber-500")}
            >
              <Star className={cn("size-[18px]", n <= rating && "fill-current")} />
            </button>
          ))}
        </div>
        <Textarea className="mt-4" rows={2} maxLength={500} value={note} disabled={sent} onChange={(e) => setNote(e.target.value)} placeholder={`Anything to tell ${firstName(trainer.name)}? (optional)`} />
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button variant="ghost" className="h-9 text-muted-foreground" onClick={onReport}>
            <Flag data-icon="inline-start" />
            Report a problem
          </Button>
          <Button variant="outline" className="h-9 px-4" disabled={!rating || sending || sent || !result.sessionId} onClick={() => void send()}>
            {sent ? <><Check data-icon="inline-start" /> Sent</> : sending ? "Sending…" : "Send rating"}
          </Button>
        </div>
      </section>

      <Collapsible className={cn(CARD, "flex flex-col")}>
        <CollapsibleTrigger className="group flex items-center justify-between text-left text-[17px] font-semibold tracking-[-0.015em] outline-none">
          Transcript
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-4 flex flex-col gap-3">
            {result.turns.length ? (
              result.turns.map((turn) => <Bubble key={turn.id} speaker={turn.speaker}>{turn.text}</Bubble>)
            ) : (
              <p className="m-0 text-sm text-muted-foreground">Nothing was said.</p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** Report a problem with a session (reference learnerIssueSheet), saved as an issue report for the trainer's team. */
function ReportDialog({ twin, sessionId, onClose }: { twin: Twin; sessionId: string | null; onClose: () => void }): ReactNode {
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  async function send() {
    setSending(true);
    try {
      const message = [`Twin session report · ${twin.name} (${twin.slug})${sessionId ? ` · session ${sessionId}` : ""}`, reasons.length ? `Reasons: ${reasons.join(", ")}` : "", text.trim()].filter(Boolean).join("\n");
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "bug", message, url: window.location.href }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not send the report");
      setDone(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the report");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>Thanks for flagging it</DialogTitle>
              <DialogDescription>The team will review this conversation.</DialogDescription>
            </DialogHeader>
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Report an issue</DialogTitle>
              <DialogDescription>What went wrong? Choose all that apply.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              {ISSUES.map((reason) => {
                const on = reasons.includes(reason);
                return (
                  <button
                    key={reason}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setReasons((prev) => (on ? prev.filter((r) => r !== reason) : [...prev, reason]))}
                    className={cn(PILL, on && "bg-foreground text-background hover:bg-foreground/85")}
                  >
                    {on ? <Check className="size-3.5" /> : null}
                    {reason}
                  </button>
                );
              })}
            </div>
            <Textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell us more (optional)" />
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button className="bg-(--brand) text-white hover:bg-[#e04d00]" disabled={sending || (!reasons.length && text.trim().length < 5)} onClick={() => void send()}>
                {sending ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
