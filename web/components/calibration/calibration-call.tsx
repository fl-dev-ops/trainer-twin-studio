"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Flag, LoaderCircle, Volume2 } from "lucide-react";
import { RoomAudioRenderer, RoomContext, useStartAudio, useVoiceAssistant } from "@livekit/components-react";
import { Room, RoomEvent, type TranscriptionSegment } from "livekit-client";
import {
  ArrowUpRightIcon,
  CallEndedIcon,
  ChatIcon,
  FeelsLikeMeIcon,
  FeelsOffIcon,
  HangUpIcon,
  MicIcon,
  PhoneIcon,
} from "@/components/calibration/call-icons";
import type { CalibrationTurn, Rating } from "@/components/calibration/mock";
import { Bubble, CalibrationStats, PILL, RatingLabel, SOFT_SHADOW, TwinPortrait } from "@/components/calibration/parts";
import { RoleplayIcon } from "@/components/icons";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import { twinClient } from "@/lib/twin/client";
import { isFeelsOffMessage, joinsLearnerTurn, type CalibrationScore } from "@/lib/twin/stats";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Phase = "connecting" | "live" | "ended" | "error";
type Connection = { sessionId: string; runtimeToken: string };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const CONTROL =
  "grid size-[54px] place-items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 [&_svg]:size-[22px]";
const ignoreSurface = () => undefined;

/** A failure retrying won't fix (4xx). */
class PermanentError extends Error {}

/** Retries transient failures (network, 5xx) with a short backoff; permanent ones throw at once. */
async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || error instanceof PermanentError) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Calibration call (V2 prototype "Talk to my twin"): a real LiveKit session with the agent's persona, through
 * the same session API as /talk. With `twin`, the call is saved as a twin calibration and every rating is stored
 * (twin tRPC); without it (role plays) ratings live only in this page.
 */
type CallProps = {
  slug: string;
  scenarioName: string;
  twinName: string;
  twin?: boolean;
  photoUrl?: string | null;
  /**
   * A learner's conversation (the /t/ link) instead of a calibration: started with their assignment code (minutes
   * enforced), no ratings, the learner page's header, minutes left on the portrait, Report issue, and the result
   * handed back when it ends (End completes the call, so its minutes and report count).
   */
  learner?: LearnerCall;
};

export type CallResult = { sessionId: string | null; seconds: number; turns: CalibrationTurn[] };
export type LearnerCall = {
  /** The learner's assignment code; null for a studio member's preview (started by slug: no minutes, not counted). */
  code: string | null;
  /** Null in a preview (no minutes). */
  minutesLeft: number | null;
  header: ReactNode;
  onReport: (sessionId: string | null) => void;
  onEnded: (result: CallResult) => void;
};

export function CalibrationCall(props: CallProps) {
  const room = useMemo(
    () => new Room({ adaptiveStream: true, audioCaptureDefaults: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } }),
    [],
  );
  return (
    <RoomContext.Provider value={room}>
      <Call room={room} {...props} />
      <RoomAudioRenderer />
    </RoomContext.Provider>
  );
}

function Call({ room, slug, scenarioName, twinName, twin = false, photoUrl = null, learner }: CallProps & { room: Room }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [turns, setTurns] = useState<CalibrationTurn[]>([]);
  const [liveText, setLiveText] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  /** Typing instead of speaking: the message box above the call controls. */
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  /** Ending: ratings flushing, transcript saving, leaving the room (the End dialog shows it). */
  const [ending, setEnding] = useState(false);

  const turnsRef = useRef<CalibrationTurn[]>([]);
  /** Twin calls: the stored calibration this call's ratings go to. Rating waits until it exists. */
  const [calibrationId, setCalibrationId] = useState<string | null>(null);
  const [calibrationFailed, setCalibrationFailed] = useState(false);
  /** Rating saves still in flight; ending the call or leaving waits for them. */
  const pendingRatings = useRef(new Set<Promise<unknown>>());
  const backHref = twin ? `/twin/${encodeURIComponent(slug)}/calibration` : "/agents";
  const connectionRef = useRef<Connection | null>(null);
  const startedRef = useRef(false);
  const endingRef = useRef(false);
  /** True once the room has connected; a disconnect before that is a failed start, not the end of a call. */
  const joinedRef = useRef(false);
  const nextId = useRef(0);
  /** Typed messages already shown; the agent echoes each back as your transcript once, which is skipped. */
  const typedEchoes = useRef<string[]>([]);
  const { state: agentState } = useVoiceAssistant();
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({ room, props: {} });

  const updateTurns = useCallback((next: (turns: CalibrationTurn[]) => CalibrationTurn[]) => {
    setTurns((prev) => {
      const updated = next(prev);
      turnsRef.current = updated;
      return updated;
    });
  }, []);

  /**
   * Saves the transcript and closes the session on the server, as /talk does. Retried on network and 5xx
   * failures. keepalive only when the page is going away (it caps the body at 64 KB); the agent's webhook
   * also delivers the full transcript, so this is the fast path, not the only one.
   */
  const closeSession = useCallback(async (status: "completed" | "abandoned", unloading = false) => {
    const active = connectionRef.current;
    if (!active) return true;
    const body = JSON.stringify({
      sessionId: active.sessionId,
      status,
      transcript: turnsRef.current.map((t) => ({ role: t.speaker === "you" ? "user" : "trainer", text: t.text })),
    });
    try {
      await withRetries(async () => {
        const response = await fetch("/api/sessions/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: unloading,
        });
        if (response.status >= 500) throw new Error(`finalize returned ${response.status}`);
        if (!response.ok) throw new PermanentError(`finalize returned ${response.status}`);
      }, unloading ? 1 : 3);
      return true;
    } catch (saveError) {
      console.error("Could not save calibration transcript:", saveError);
      return false;
    }
  }, []);

  const end = useCallback(
    async (status: "completed" | "abandoned", unloading = false) => {
      if (endingRef.current) return;
      endingRef.current = true;
      setEnding(true);
      // Ratings first: the summary and the review must show every rating that was made.
      await Promise.allSettled([...pendingRatings.current]);
      const saved = await closeSession(status, unloading);
      if (!saved && !unloading) toast.error("The call's transcript could not be saved.");
      await room.disconnect().catch(() => {});
      setComposerOpen(false);
      setConfirmEnd(false);
      setEnding(false);
      setPhase("ended");
    },
    [room, closeSession],
  );

  const start = useCallback(async () => {
    endingRef.current = false;
    joinedRef.current = false;
    connectionRef.current = null;
    turnsRef.current = [];
    // A new call keeps nothing from the previous one.
    nextId.current = 0;
    typedEchoes.current = [];
    pendingRatings.current.clear();
    setCalibrationId(null);
    setCalibrationFailed(false);
    setConnection(null);
    setTurns([]);
    setLiveText("");
    setSeconds(0);
    setMuted(false);
    setError("");
    setPhase("connecting");
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A learner starts with their assignment code: access and minutes are checked by the session start.
        body: JSON.stringify(learner?.code ? { shareCode: learner.code, idempotencyKey: crypto.randomUUID() } : { agentSlug: slug, idempotencyKey: crypto.randomUUID() }),
      });
      const launch = await response.json().catch(() => ({}));
      if (!response.ok || !launch.session?.id || !launch.participantToken) {
        throw new Error(launch.error ?? "Could not start the call.");
      }
      const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
      if (!url) throw new Error("Voice calls are not configured.");
      const active = { sessionId: launch.session.id as string, runtimeToken: launch.session.runtimeToken as string };
      connectionRef.current = active;
      setConnection(active);
      if (twin && !learner) {
        // Saved as a calibration before anything can be rated (rating stays off until then); a failure only
        // loses the ratings, not the call. Creating it is idempotent, so retrying is safe.
        void withRetries(() => twinClient.calibrations.start.mutate({ slug, sessionId: active.sessionId }))
          .then(({ calibrationId: id }) => setCalibrationId(id))
          .catch((saveError) => {
            console.error("Could not save the calibration:", saveError);
            setCalibrationFailed(true);
            toast.error("Ratings in this call can't be saved.");
          });
      }
      await room.connect(url, launch.participantToken).catch((connectError) => {
        console.error("LiveKit connect failed:", connectError);
        throw new Error("Could not connect to the call. Check your connection and try again.");
      });
      joinedRef.current = true;

      // Same hand-off as /talk: once the agent is in the room, open the mic and let it speak first.
      const release = async () => {
        await room.localParticipant.setMicrophoneEnabled(true).catch((micError) => console.error("Microphone failed:", micError));
        await room.localParticipant
          .publishData(new TextEncoder().encode(JSON.stringify({ type: "begin-opening" })), { reliable: true })
          .catch((dataError) => console.error("Could not release the opening:", dataError));
        setPhase("live");
      };
      if (room.remoteParticipants.size > 0) await release();
      else room.once(RoomEvent.ParticipantConnected, () => void release());
    } catch (startError) {
      endingRef.current = true;
      void closeSession("abandoned");
      await room.disconnect().catch(() => {});
      setError(startError instanceof Error ? startError.message : "Could not start the call.");
      setPhase("error");
    }
  }, [room, slug, closeSession, twin, learner]);

  // Start once on open; the ref stops React's dev double-mount from starting a second session.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Leaving the page mid-call still closes the session (pending rating saves can't be awaited here; Back does).
  useEffect(
    () => () => {
      if (!endingRef.current && connectionRef.current) void end("abandoned", true);
    },
    [end],
  );

  // A learner's call hands its result to the learner page (which shows the summary and feedback).
  const onEnded = learner?.onEnded;
  useEffect(() => {
    if (phase === "ended" && onEnded) onEnded({ sessionId: connectionRef.current?.sessionId ?? null, seconds, turns: turnsRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ended call, with the values at that moment
  }, [phase, onEnded]);

  useEffect(() => {
    if (phase !== "live") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    function onTranscription(segments: TranscriptionSegment[], participant?: { identity?: string }) {
      const isYou = participant?.identity === room.localParticipant.identity;
      for (const segment of segments) {
        if (!segment.text) continue;
        if (!segment.final) {
          setLiveText(isYou ? "" : segment.text);
          continue;
        }
        if (!isYou) setLiveText("");
        const text = segment.text;
        const echo = isYou ? typedEchoes.current.indexOf(text.trim()) : -1;
        if (echo >= 0) {
          typedEchoes.current.splice(echo, 1);
          continue;
        }
        updateTurns((prev) => {
          const last = prev[prev.length - 1];
          // The agent re-sends a growing final for one utterance; keep it as one turn (as /talk does).
          if (!isYou && last?.speaker === "twin" && (last.text === text || text.startsWith(last.text))) {
            return [...prev.slice(0, -1), { ...last, text }];
          }
          // Your speech arrives in pieces: keep adding to your bubble until the twin replies.
          if (isYou && joinsLearnerTurn(last, text)) return [...prev.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
          return [...prev, { id: `t${nextId.current++}`, speaker: isYou ? "you" : "twin", text }];
        });
      }
    }
    function onData(payload: Uint8Array) {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; status?: string };
        if (data.type === "session-ended" && data.status === "completed") void end("completed");
      } catch {
        // not JSON: ignore
      }
    }
    function onDisconnected() {
      if (joinedRef.current && !endingRef.current) void end("abandoned");
    }
    room.on(RoomEvent.TranscriptionReceived, onTranscription);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, onTranscription);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, end, updateTurns]);

  /** Twin calls rate only once their calibration exists; role plays rate on the page only. */
  const canRate = !twin || calibrationId !== null;
  const rate = (id: string, rating: Rating) => {
    if (!canRate) return;
    updateTurns((prev) => prev.map((t) => (t.id === id ? { ...t, rating } : t)));
    if (!twin || !calibrationId) return;
    const turns = turnsRef.current;
    const turnIndex = turns.findIndex((t) => t.id === id);
    if (turnIndex < 0) return;
    const question = turns.slice(0, turnIndex).reverse().find((t) => t.speaker === "you")?.text ?? null;
    const reply = turns[turnIndex].text;
    const write: Promise<unknown> = withRetries(() => twinClient.calibrations.rate.mutate({ calibrationId, turnIndex, question, reply, rating }))
      .catch((saveError) => {
        console.error("Could not save the rating:", saveError);
        toast.error("That rating was not saved.");
      })
      .finally(() => pendingRatings.current.delete(write));
    pendingRatings.current.add(write);
  };

  /** A typed message: the agent reads lk.chat like speech and replies; it counts as your turn here. */
  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    setDraft("");
    await say(text);
  }

  async function say(text: string) {
    if (!text || phase !== "live") return;
    typedEchoes.current.push(text);
    updateTurns((prev) => {
      const last = prev[prev.length - 1];
      return joinsLearnerTurn(last, text)
        ? [...prev.slice(0, -1), { ...last, text: `${last.text} ${text}` }]
        : [...prev, { id: `t${nextId.current++}`, speaker: "you", text }];
    });
    await room.localParticipant.sendText(text, { topic: "lk.chat" }).catch((sendError) => {
      console.error("Could not send the message:", sendError);
      toast.error("That message was not sent.");
    });
  }

  async function toggleMute() {
    const next = !muted;
    setMuted(next);
    await room.localParticipant.setMicrophoneEnabled(!next).catch(() => setMuted(!next));
  }

  // Show the twin's words as they stream in, then the finished turn with its rating buttons.
  const captions: (CalibrationTurn & { streaming?: boolean })[] = liveText
    ? [...turns, { id: "streaming", speaker: "twin", text: liveText, streaming: true }]
    : turns;
  const speaking = agentState === "speaking";
  /** Only the twin's latest finished answer can be rated; earlier ones keep their rating (or none). */
  const latestTwinId = turns.findLast((t) => t.speaker === "twin")?.id;

  // Follow the conversation: keep the newest turn in view as it grows.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns.length, liveText]);

  return (
    <LiveKitWorkspaceProvider
      sessionId={connection?.sessionId}
      runtimeToken={connection?.runtimeToken}
      onSurface={ignoreSurface}
      onEndSession={() => void end("completed")}
      active={phase === "live"}
    >
      <div className="relative flex h-dvh max-h-dvh flex-col overflow-hidden">
        {learner ? (
          learner.header
        ) : (
          <h1 className="m-0 truncate px-8 pt-6 text-sm font-medium text-foreground/90">{scenarioName}</h1>
        )}

        {phase === "ended" && learner ? null : phase === "ended" ? (
          <CallSummary
            transcriptHref={
              twin
                ? calibrationId ? `/twin/${encodeURIComponent(slug)}/calibration/${encodeURIComponent(calibrationId)}` : undefined
                : connection?.sessionId ? `/sessions/${encodeURIComponent(connection.sessionId)}` : undefined
            }
            backHref={backHref}
            backLabel={twin ? "All calibrations" : "Go to Roleplay"}
            twinName={twinName}
            photoUrl={photoUrl}
            seconds={seconds}
            turns={turns}
            calibrationId={twin ? calibrationId : null}
            onRestart={() => void start()}
          />
        ) : (
          <>
            <div ref={scrollRef} className={cn("flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-8", composerOpen ? "pb-44" : "pb-28")}>
              <div className={cn("relative size-[320px] shrink-0 overflow-hidden rounded-[32px] bg-muted", SOFT_SHADOW, speaking && "ring-2 ring-emerald-500/70")}>
                <TwinPortrait name={twinName} photoUrl={photoUrl} className="size-full text-8xl" />
                <span className="absolute right-3 bottom-3 rounded-full bg-black/45 px-2.5 py-1 text-[13px] leading-[18px] font-medium text-white tabular-nums">
                  <span className="sr-only">Call time </span>
                  {clock(seconds)}
                  {learner?.minutesLeft != null ? ` · ${Math.max(0, learner.minutesLeft - Math.ceil(seconds / 60))} min left` : ""}
                </span>
              </div>

              {!canPlayAudio && phase === "live" ? (
                <button {...audioProps} type="button" className={cn(PILL, "mt-6")}>
                  <Volume2 className="size-4" />
                  Turn on sound
                </button>
              ) : null}

              <div aria-live="polite" className="mt-8 flex w-full max-w-[440px] flex-col gap-4">
                {phase === "error" ? (
                  <div role="alert" className="flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <button type="button" className={PILL} onClick={() => void start()}>
                      Try again
                    </button>
                  </div>
                ) : phase === "connecting" ? (
                  <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" aria-hidden />
                    Connecting to {twinName}…
                  </p>
                ) : captions.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground">{twinName} will start in a moment.</p>
                ) : (
                  captions.map((turn, index, shown) =>
                    turn.speaker === "you" ? (
                      <Bubble key={turn.id} speaker="you" className="max-w-[440px]">
                        {turn.text}
                      </Bubble>
                    ) : (
                      <div key={turn.id} className="flex flex-col gap-2">
                        {speaking && index === shown.length - 1 ? (
                          <p className="flex items-center gap-2 text-[13px] leading-[18px] font-medium text-foreground/75">
                            <span aria-hidden className="size-2 animate-pulse rounded-full bg-[#ce2c33] ring-3 ring-[#ce2c33]/20" />
                            {twinName} speaking
                          </p>
                        ) : null}
                        <Bubble speaker="twin">{turn.text}</Bubble>
                        {turn.streaming || learner ? null : turn.rating ? (
                          <RatingLabel rating={turn.rating} className="text-[13px]" />
                        ) : turn.id !== latestTwinId ? null : (
                          <div className="flex flex-wrap items-center gap-2">
                            <button type="button" className={cn(PILL, "disabled:opacity-50")} disabled={!canRate} onClick={() => rate(turn.id, "like")}>
                              <FeelsLikeMeIcon className="size-4" />
                              Feels like me
                            </button>
                            <button
                              type="button"
                              className={cn(PILL, "disabled:opacity-50")}
                              disabled={!canRate}
                              // The twin then asks what felt off, and moves on once you've explained.
                              onClick={() => {
                                rate(turn.id, "off");
                                void say("Feels off");
                              }}
                            >
                              <FeelsOffIcon className="size-4" />
                              Feels off
                            </button>
                            {twin && !canRate ? (
                              <span className="text-xs text-muted-foreground">
                                {calibrationFailed ? "Ratings can't be saved in this call." : "Getting ready to save ratings\u2026"}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ),
                  )
                )}
              </div>
            </div>

            {/* Pinned to the bottom of the window; the area above leaves room for it. */}
            <div className="fixed inset-x-0 bottom-0 z-10 flex flex-col items-center gap-4 bg-background px-6 pt-3 pb-6">
              {composerOpen ? (
                <form onSubmit={(event) => void sendMessage(event)} className="flex w-full max-w-[440px] items-center gap-2 rounded-full border bg-card p-1.5 pl-4">
                  <label htmlFor="calibration-message" className="sr-only">
                    Message {twinName}
                  </label>
                  <input
                    id="calibration-message"
                    autoFocus
                    autoComplete="off"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setComposerOpen(false)}
                    placeholder={`Type a message to ${twinName}`}
                    disabled={phase !== "live"}
                    maxLength={2000}
                    className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    aria-label="Send message"
                    disabled={phase !== "live" || !draft.trim()}
                    className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                </form>
              ) : null}
            <div className="flex justify-center gap-4">
              <button
                type="button"
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
                disabled={phase !== "live"}
                onClick={() => void toggleMute()}
                className={cn(CONTROL, muted ? "bg-foreground text-background" : "border bg-muted hover:bg-border")}
              >
                <MicIcon off={muted} />
              </button>
              <button
                type="button"
                aria-label={composerOpen ? "Close message box" : "Type a message"}
                aria-pressed={composerOpen}
                onClick={() => setComposerOpen(!composerOpen)}
                style={{ "--call-chat-lines": composerOpen ? "var(--card)" : "var(--muted)" } as React.CSSProperties}
                className={cn(CONTROL, "border", composerOpen ? "bg-card" : "bg-muted hover:bg-border")}
              >
                <ChatIcon />
              </button>
              {learner ? (
                <button
                  type="button"
                  aria-label="Report an issue"
                  title="Report an issue"
                  onClick={() => learner.onReport(connectionRef.current?.sessionId ?? null)}
                  className={cn(CONTROL, "border bg-muted hover:bg-border")}
                >
                  <Flag />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="End call"
                disabled={phase === "error"}
                onClick={() => (phase === "live" ? setConfirmEnd(true) : void end("abandoned"))}
                className={cn(CONTROL, "bg-[#ce2c33] text-white hover:bg-[#b5262c]")}
              >
                <HangUpIcon />
              </button>
            </div>
            </div>

            <AlertDialog open={confirmEnd} onOpenChange={(open) => !ending && setConfirmEnd(open)}>
              <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-6 rounded-3xl px-6 pt-8 pb-6">
                <AlertDialogTitle className="max-w-[300px] text-center text-xl leading-7 font-semibold tracking-[-0.015em]">
                  Do you want to end the conversation?
                </AlertDialogTitle>
                <div className="grid w-full grid-cols-2 gap-2">
                  <button type="button" disabled={ending} className={cn(PILL, "h-10 justify-center px-4 text-sm disabled:opacity-70")} onClick={() => void end(learner ? "completed" : "abandoned")}>
                    {ending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
                    {ending ? "Ending the call\u2026" : "Yes, end the call"}
                  </button>
                  <AlertDialogCancel variant="default" disabled={ending} className="h-10 rounded-full px-4 text-sm font-semibold">
                    No, I’ll continue
                  </AlertDialogCancel>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </LiveKitWorkspaceProvider>
  );
}

/** After the call: how long it ran and how the answers were rated. */
function CallSummary({
  transcriptHref,
  backHref,
  backLabel,
  twinName,
  photoUrl,
  seconds,
  turns,
  calibrationId,
  onRestart,
}: {
  transcriptHref?: string;
  backHref: string;
  backLabel: string;
  twinName: string;
  photoUrl: string | null;
  seconds: number;
  turns: CalibrationTurn[];
  /** Twin calibrations: Jev counts the turns and the meant "Feels off" from the saved call. */
  calibrationId: string | null;
  onRestart: () => void;
}) {
  // What the call itself shows: every line of yours except the Feels off button's, every Feels off.
  const raw = useMemo<CalibrationScore>(() => ({
    turns: turns.filter((turn) => turn.speaker === "you" && !isFeelsOffMessage(turn.text)).length,
    off: turns.filter((turn) => turn.rating === "off").length,
  }), [turns]);
  /** Jev's count for a twin calibration (the raw count if it fails); null while counting. */
  const [counted, setCounted] = useState<CalibrationScore | null>(null);
  useEffect(() => {
    if (!calibrationId) return;
    let live = true;
    twinClient.calibrations.score
      .mutate({ calibrationId })
      .then((result) => live && setCounted({ turns: result.turns, off: result.off }))
      .catch(() => live && setCounted(raw));
    return () => {
      live = false;
    };
  }, [calibrationId, raw]);
  const score = calibrationId ? counted : raw;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-20 pb-10">
      <p className="flex items-center gap-2 rounded-full bg-muted px-4 py-1.5 text-sm font-medium text-foreground/75">
        <CallEndedIcon className="size-[18px]" />
        Call ended
      </p>
      <TwinPortrait name={twinName} photoUrl={photoUrl} className={cn("mt-6 size-60 rounded-[48px] text-7xl", SOFT_SHADOW)} />
      <h1 className="mt-6 text-lg font-semibold">{twinName}</h1>
      <p className="mt-0.5 text-sm text-foreground/75">Time spoke {clock(seconds)}</p>
      {transcriptHref ? (
        <Link
          href={transcriptHref}
          className="mt-5 flex items-center gap-1.5 text-sm font-medium text-foreground/75 hover:text-foreground"
        >
          View transcript
          <ArrowUpRightIcon className="size-4" />
        </Link>
      ) : null}
      <div className="mt-6 w-full max-w-[560px]">
        <CalibrationStats score={score} />
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
        <Link href={backHref} className={cn(PILL, "h-10 px-4 text-sm")}>
          <RoleplayIcon className="size-[18px]" />
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
