"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Flag, Star } from "lucide-react";
import { toast } from "sonner";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { CalibrationCall, type CallResult } from "@/components/calibration/calibration-call";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
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

const card = "rounded-[16px] border border-(--card-border) bg-card p-5";
const primary = "h-12 w-full rounded-full bg-(--brand) text-[15px] font-semibold text-white hover:bg-[#e04d00]";
const link = "text-sm font-medium text-(--brand) hover:underline";
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

  const header = (
    <header className="mx-auto flex w-full max-w-[600px] items-center justify-between gap-3 px-5 pt-6">
      <span className="flex min-w-0 items-center gap-3">
        <UserAvatar user={{ name: trainer.name, image: trainer.photoUrl }} className="size-11 text-sm" />
        <span className="flex min-w-0 flex-col">
          <b className="truncate text-[15px] font-semibold">{trainer.name}</b>
          {trainer.title ? <small className="truncate text-[13px] text-muted-foreground">{trainer.title}</small> : null}
        </span>
      </span>
      {minutesLeft !== null && step !== "landing" ? (
        <span className="shrink-0 rounded-full border border-(--card-border) px-3 py-1.5 text-[13px] font-semibold tabular-nums">{minutesLeft} min left</span>
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
      <main className="mx-auto flex w-full max-w-[600px] flex-1 flex-col gap-4 px-5 pt-8 pb-12">
        {step === "landing" ? (
          <>
            <TwinCard trainer={trainer} twin={twin} />
            <Button className={primary} onClick={() => setStep(access ? "check" : "signin")}>Start conversation</Button>
            <p className="m-0 text-center text-[13px] text-muted-foreground">
              You&apos;ll sign in with Google so {firstName(trainer.name)} knows it&apos;s you. Conversations are recorded to help you and {firstName(trainer.name)}.
            </p>
          </>
        ) : step === "signin" ? (
          <>
            <h1 className="m-0 text-[26px] leading-8 font-semibold tracking-[-0.015em]">Who&apos;s practising?</h1>
            <p className="m-0 text-[15px] text-muted-foreground">Sign in with the Google account {firstName(trainer.name)} has for you.</p>
            <GoogleSignInButton callbackURL={`${typeof window === "undefined" ? "" : window.location.origin}${path}?start=1`} className="h-12 w-full rounded-full text-[15px]" />
            <button type="button" className={cn(link, "self-center")} onClick={() => setStep("landing")}>Back</button>
          </>
        ) : step === "check" && access ? (
          <>
            <TwinCard trainer={trainer} twin={twin} />
            {access.ok ? (
              <>
                <div className={cn(card, "flex flex-col gap-3")}>
                  <span className="text-[13px] font-semibold tracking-[0.06em] text-emerald-600 uppercase dark:text-emerald-400">You&apos;re in, {firstName(access.name)}</span>
                  <span className="block h-1.5 overflow-hidden rounded-full bg-(--tone-control)">
                    <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((access.minutesLeft / Math.max(1, access.minutesTotal)) * 100)}%` }} />
                  </span>
                  <p className="m-0 text-[15px] font-medium tabular-nums">{access.minutesLeft} of {access.minutesTotal} minutes left</p>
                  <small className="text-[13px] text-muted-foreground">Minutes count for the whole conversation, from start to end.</small>
                </div>
                <Button className={primary} onClick={() => setStep("call")}>Start voice call</Button>
                <p className="m-0 text-center text-[13px] text-muted-foreground">We&apos;ll ask for your microphone.</p>
              </>
            ) : (
              <div className={cn(card, "flex flex-col gap-2")}>
                <span className="text-[13px] font-semibold tracking-[0.06em] text-amber-600 uppercase dark:text-amber-400">Not available</span>
                <p className="m-0 text-[15px]">{access.reason}.</p>
                <small className="text-[13px] text-muted-foreground">Signed in as {access.email}. Ask {firstName(trainer.name)} for access, or use the account they invited.</small>
              </div>
            )}
            <button type="button" className={cn(link, "self-center")} onClick={signOutAndRestart}>Use a different account</button>
          </>
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
          <TwinCard trainer={trainer} twin={twin} />
        )}
      </main>
      <footer className="pb-6 text-center text-[13px] text-muted-foreground">{trainer.name}</footer>
      {report}
    </div>
  );
}

function TwinCard({ trainer, twin }: { trainer: Trainer; twin: Twin }) {
  return (
    <div className={cn(card, "flex flex-col gap-3")}>
      <UserAvatar user={{ name: trainer.name, image: trainer.photoUrl }} className="size-20 text-2xl" />
      <span className="text-[13px] font-semibold tracking-[0.06em] text-(--brand) uppercase">Twin · voice call</span>
      <h1 className="m-0 text-[22px] leading-7 font-semibold tracking-[-0.015em]">{twin.name}</h1>
      {twin.description ? <p className="m-0 text-[15px] leading-6 text-muted-foreground">{twin.description}</p> : null}
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
      <h1 className="m-0 text-[26px] leading-8 font-semibold tracking-[-0.015em]">Conversation complete</h1>
      <p className="m-0 text-[15px] text-muted-foreground">{twin.name}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className={cn(card, "flex flex-col gap-1")}>
          <span className="text-[12px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">This session</span>
          <b className="text-[26px] font-semibold tabular-nums">{used} min</b>
          <small className="text-[13px] text-muted-foreground tabular-nums">{clock(result.seconds)} talked</small>
        </div>
        <div className={cn(card, "flex flex-col gap-1")}>
          <span className="text-[12px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Minutes left</span>
          <b className="text-[26px] font-semibold tabular-nums">{minutesLeft ?? "—"}</b>
          <small className="text-[13px] text-muted-foreground">with this twin</small>
        </div>
      </div>

      <section className={cn(card, "flex flex-col gap-3")}>
        <h2 className="m-0 text-[17px] font-semibold">How helpful was this?</h2>
        <div role="radiogroup" aria-label="Rating" className="flex gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              disabled={sent}
              onClick={() => setRating(n)}
              className={cn("grid size-11 place-items-center rounded-xl border border-(--card-border) transition-colors disabled:opacity-60", n <= rating ? "bg-amber-400/15 text-amber-500" : "text-muted-foreground hover:bg-(--tone-control)")}
            >
              <Star className={cn("size-5", n <= rating && "fill-current")} />
            </button>
          ))}
        </div>
        <Textarea rows={2} maxLength={500} value={note} disabled={sent} onChange={(e) => setNote(e.target.value)} placeholder={`Anything to tell ${firstName(trainer.name)}? (optional)`} />
        <Button variant="outline" className="h-11 rounded-full" disabled={!rating || sending || sent || !result.sessionId} onClick={() => void send()}>
          {sent ? <><Check data-icon="inline-start" /> Thanks, sent</> : sending ? "Sending…" : "Send rating"}
        </Button>
      </section>

      <button type="button" className={cn(link, "self-center inline-flex items-center gap-1.5")} onClick={onReport}>
        <Flag className="size-3.5" /> Report a problem with this session
      </button>

      <details className={cn(card, "group")}>
        <summary className="cursor-pointer text-[17px] font-semibold">Transcript</summary>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          {result.turns.length ? result.turns.map((turn) => (
            <p key={turn.id} className="m-0"><b>{turn.speaker === "you" ? "You" : twin.name}:</b> {turn.text}</p>
          )) : <p className="m-0 text-muted-foreground">Nothing was said.</p>}
        </div>
      </details>

      <Button className={primary} onClick={onAgain} disabled={minutesLeft !== null && minutesLeft <= 0}>Start another</Button>
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
                    className={cn("rounded-full border px-3 py-1.5 text-sm transition-colors", on ? "border-(--brand) bg-(--brand)/10 text-(--brand)" : "border-(--card-border) hover:bg-(--tone-control)")}
                  >
                    {reason}
                  </button>
                );
              })}
            </div>
            <Textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell us more (optional)" />
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={sending || (!reasons.length && text.trim().length < 5)} onClick={() => void send()}>{sending ? "Sending…" : "Send report"}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
