"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Flag, Lock, LogIn, LogOut, Star } from "lucide-react";
import { toast } from "sonner";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { CalibrationCall, type CallResult } from "@/components/calibration/calibration-call";
import { CallEndedIcon, PhoneIcon } from "@/components/calibration/call-icons";
import { Bubble, PILL, TwinPortrait } from "@/components/calibration/parts";
import { BrandMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/** The signed-in person's access to this twin (null: signed out). */
export type LearnerAccess =
  | { ok: true; name: string; email: string; code: string; minutesLeft: number; minutesTotal: number }
  | { ok: false; name: string; email: string; reason: "unassigned" | "ended" | "used" }
  | null;

type Trainer = { name: string; title: string | null; bio: string | null; photoUrl: string | null };
type Twin = { slug: string; name: string; description: string | null };
type Step = "profile" | "call" | "summary";

// The dash's own scale (twin overview cards): 16px cards with the soft shadow, 11px labels, 18px titles, 15px body.
const CARD = "rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";
const LABEL = "m-0 text-[11px] font-medium tracking-[0.08em] uppercase";
const TITLE = "m-0 text-[18px] leading-7 font-semibold tracking-[-0.015em]";
const BODY = "m-0 text-[15px] leading-6 text-(--text-secondary)";
const BRAND = "h-10 w-full bg-(--brand) px-4 text-sm font-semibold text-white hover:bg-[#e04d00]";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const firstName = (name: string) => name.split(/[\s@]/)[0] || name;
const ISSUES = ["Wrong or made-up answer", "Didn't understand me", "Audio or connection", "Too slow", "Something else"];

/** Why someone can't talk, said plainly (title, what to do). */
function noAccessCopy(reason: "unassigned" | "ended" | "used", trainer: string) {
  if (reason === "used") return { title: "You've used all your minutes", body: `Ask ${trainer} for more time to keep practising.` };
  if (reason === "ended") return { title: "Your access has ended", body: `Ask ${trainer} if you'd like to keep practising.` };
  return { title: "You don't have access yet", body: `Ask ${trainer} to add you, or switch to the account ${trainer} invited.` };
}

/**
 * A learner's whole visit on a twin link, on one page, laid out like a profile (Delphi-style): the trainer, the twin
 * you can talk to and your minutes, a call dock at the bottom; Google sign-in in a dialog (back to this page); the
 * call (the calibration screen, learner mode); then a summary with a rating, a problem report and the transcript.
 * Never sends people to the auth pages.
 */
export function TwinLearnerFlow({ path, trainer, twin, access }: { path: string; trainer: Trainer; twin: Twin; access: LearnerAccess }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("profile");
  const [signingIn, setSigningIn] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [reportFor, setReportFor] = useState<{ sessionId: string | null } | null>(null);
  const minutesLeft = access?.ok ? access.minutesLeft : null;
  const coach = firstName(trainer.name);

  function switchAccount() {
    void authClient.signOut().finally(() => {
      router.refresh();
      setSigningIn(true);
    });
  }

  // Top bar (Delphi-style): the brand on the left; sign in, or your account, on the right (minutes during a call).
  const topBar = (
    <header className="flex h-14 w-full shrink-0 items-center justify-between gap-3 px-5">
      <span className="flex items-center gap-1.5">
        <BrandMark className="size-5 text-primary" />
        <span className="text-base leading-none font-semibold tracking-[-0.02em]">TrainerTwin</span>
      </span>
      {step !== "profile" && minutesLeft !== null ? (
        <span className="rounded-full bg-(--tone-control) px-3 py-1 text-xs font-medium tabular-nums">{minutesLeft} min left</span>
      ) : access ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" className="h-9 gap-2 pr-3 pl-1.5" />}>
            <UserAvatar user={{ name: access.name, email: access.email }} size="sm" />
            <span className="max-w-[140px] truncate text-sm font-medium">{firstName(access.name)}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{access.email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={switchAccount}>
                <LogOut />
                Switch account
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button variant="ghost" className="h-9 px-3" onClick={() => setSigningIn(true)}>
          <LogIn data-icon="inline-start" />
          Sign in
        </Button>
      )}
    </header>
  );

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
            header: topBar,
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

  const blocked = access && !access.ok ? noAccessCopy(access.reason, coach) : null;
  return (
    <div className="flex min-h-svh flex-col bg-background">
      {topBar}
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-4 px-5 pt-8 pb-40">
        {step === "summary" && result ? (
          <Summary
            twin={twin}
            trainer={trainer}
            result={result}
            minutesLeft={minutesLeft}
            onReport={() => setReportFor({ sessionId: result.sessionId })}
            onAgain={() => setStep("call")}
          />
        ) : (
          <>
            {/* Profile hero: the trainer whose twin this is. */}
            <section className="flex items-center gap-5">
              <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="size-24 shrink-0 rounded-[24px] text-4xl shadow-[0_2px_4px_rgb(30_28_25/0.06),0_8px_20px_rgb(30_28_25/0.1)] sm:size-28 sm:rounded-[28px]" />
              <div className="flex min-w-0 flex-col gap-1">
                <h1 className="m-0 text-[28px] leading-9 font-semibold tracking-[-0.02em]">{trainer.name}</h1>
                {trainer.title ? <p className="m-0 text-[15px] text-(--text-secondary)">{trainer.title}</p> : null}
              </div>
            </section>
            {trainer.bio ? <p className="m-0 line-clamp-3 text-[15px] leading-6 text-muted-foreground">{trainer.bio}</p> : null}

            <h2 className="mt-6 mb-0 text-[18px] leading-6 font-semibold tracking-[-0.015em]">Talk to {coach}&apos;s twin</h2>
            <article className={cn(CARD, "flex flex-col p-5")}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={cn(LABEL, "text-muted-foreground")}>Voice call</p>
                  <h3 className={TITLE}>{twin.name}</h3>
                </div>
                <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-(--brand)/10 text-(--brand)">
                  <PhoneIcon className="size-5" />
                </span>
              </div>
              {twin.description ? <p className={cn(BODY, "mt-2 line-clamp-4")}>{twin.description}</p> : null}
              {access?.ok ? (
                // Your minutes, as the twin overview's usage meter.
                <div className="mt-5 flex flex-col gap-2 border-t border-(--card-border) pt-4">
                  <p className="m-0 flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">You&apos;re in, {firstName(access.name)}</span>
                    <span className="text-muted-foreground tabular-nums">{access.minutesLeft} of {access.minutesTotal} min left</span>
                  </p>
                  <span className="block h-1.5 w-full overflow-hidden rounded-full bg-(--tone-control)">
                    <span className="block h-full rounded-full bg-(--foreground)" style={{ width: `${Math.min(100, Math.round((access.minutesLeft / Math.max(1, access.minutesTotal)) * 100))}%` }} />
                  </span>
                </div>
              ) : null}
            </article>

            {blocked && access ? (
              <article className={cn(CARD, "flex items-start gap-4 p-5")}>
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-(--tone-control) text-(--text-secondary)">
                  <Lock className="size-[18px]" />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="m-0 text-[15px] leading-6 font-semibold">{blocked.title}</h3>
                  <p className="m-0 text-sm text-muted-foreground">{blocked.body}</p>
                  <p className="mt-2 mb-0 text-xs text-muted-foreground">
                    Signed in as {access.email} ·{" "}
                    <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={switchAccount}>
                      Switch account
                    </button>
                  </p>
                </div>
              </article>
            ) : null}
          </>
        )}
      </main>

      {/* Call dock (Delphi's bottom bar): one clear action, minutes beside it. Hidden when there's nothing to start. */}
      {step === "profile" && !blocked ? (
        <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 bg-linear-to-t from-background via-background/90 to-transparent px-5 pt-10 pb-5">
          <div className="flex items-center gap-3 rounded-full border border-(--card-border) bg-card p-1.5 shadow-[0_2px_4px_rgb(30_28_25/0.06),0_8px_24px_rgb(30_28_25/0.12)]">
            {access?.ok ? <span className="pl-3 text-sm text-muted-foreground tabular-nums">{access.minutesLeft} min left</span> : null}
            <Button
              className="h-11 bg-(--brand) px-6 text-[15px] font-semibold text-white hover:bg-[#e04d00]"
              disabled={access?.ok === true && access.minutesLeft <= 0}
              onClick={() => (access?.ok ? setStep("call") : setSigningIn(true))}
            >
              <PhoneIcon className="size-[18px]" />
              {access?.ok ? "Start voice call" : "Start conversation"}
            </Button>
          </div>
          <p className="m-0 text-xs text-muted-foreground">Conversations are recorded to help you and {coach}.</p>
        </div>
      ) : null}

      <Dialog open={signingIn} onOpenChange={setSigningIn}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader className="items-center text-center">
            <TwinPortrait name={trainer.name} photoUrl={trainer.photoUrl} className="mb-2 size-16 rounded-[18px] text-2xl" />
            <DialogTitle>Sign in to talk to {coach}&apos;s twin</DialogTitle>
            <DialogDescription>Use the Google account {coach} invited. Your minutes and sessions stay yours.</DialogDescription>
          </DialogHeader>
          <GoogleSignInButton callbackURL={`${typeof window === "undefined" ? "" : window.location.origin}${path}`} className="h-10 w-full text-sm" />
        </DialogContent>
      </Dialog>
      {report}
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
