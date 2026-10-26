"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Volume2 } from "lucide-react";
import { RoomAudioRenderer, RoomContext, useStartAudio, useVoiceAssistant } from "@livekit/components-react";
import { Room, RoomEvent, type TranscriptionSegment } from "livekit-client";
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
} from "@/components/calibration/call-icons";
import type { CalibrationTurn, Rating } from "@/components/calibration/mock";
import { Bubble, CalibrationStats, PANEL_SHADOW, PILL, RatingLabel, SOFT_SHADOW, TwinPortrait } from "@/components/calibration/parts";
import { RoleplayIcon } from "@/components/icons";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import { twinClient } from "@/lib/twin/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Phase = "connecting" | "live" | "ended" | "error";
type Connection = { sessionId: string; runtimeToken: string };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const CONTROL =
  "grid size-[54px] place-items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 [&_svg]:size-[22px]";
const ignoreSurface = () => undefined;

/**
 * Calibration call (V2 prototype "Talk to my twin"): a real LiveKit session with the agent's persona, through
 * the same session API as /talk. With `twin`, the call is saved as a twin calibration and every rating is stored
 * (twin tRPC); without it (role plays) ratings live only in this page.
 */
type CallProps = { slug: string; scenarioName: string; twinName: string; twin?: boolean };

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

function Call({ room, slug, scenarioName, twinName, twin = false }: CallProps & { room: Room }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [turns, setTurns] = useState<CalibrationTurn[]>([]);
  const [liveText, setLiveText] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const turnsRef = useRef<CalibrationTurn[]>([]);
  /** Twin calls: the stored calibration this call's ratings go to. */
  const calibrationRef = useRef<Promise<string | null> | null>(null);
  const [calibrationId, setCalibrationId] = useState<string | null>(null);
  const backHref = twin ? `/twin/${encodeURIComponent(slug)}/calibration` : "/agents";
  const connectionRef = useRef<Connection | null>(null);
  const startedRef = useRef(false);
  const endingRef = useRef(false);
  /** True once the room has connected; a disconnect before that is a failed start, not the end of a call. */
  const joinedRef = useRef(false);
  const nextId = useRef(0);
  const { state: agentState } = useVoiceAssistant();
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({ room, props: {} });

  const updateTurns = useCallback((next: (turns: CalibrationTurn[]) => CalibrationTurn[]) => {
    setTurns((prev) => {
      const updated = next(prev);
      turnsRef.current = updated;
      return updated;
    });
  }, []);

  /** Saves the transcript and closes the session on the server, exactly as /talk does. */
  const closeSession = useCallback(async (status: "completed" | "abandoned") => {
    const active = connectionRef.current;
    if (!active) return;
    await fetch("/api/sessions/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: active.sessionId,
        status,
        transcript: turnsRef.current.map((t) => ({ role: t.speaker === "you" ? "user" : "trainer", text: t.text })),
      }),
      keepalive: true,
    }).catch((saveError) => console.error("Could not save calibration transcript:", saveError));
  }, []);

  const end = useCallback(
    async (status: "completed" | "abandoned") => {
      if (endingRef.current) return;
      endingRef.current = true;
      await closeSession(status);
      await room.disconnect().catch(() => {});
      setPanelOpen(false);
      setConfirmEnd(false);
      setPhase("ended");
    },
    [room, closeSession],
  );

  const start = useCallback(async () => {
    endingRef.current = false;
    joinedRef.current = false;
    connectionRef.current = null;
    turnsRef.current = [];
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
        body: JSON.stringify({ agentSlug: slug, idempotencyKey: crypto.randomUUID() }),
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
      if (twin) {
        // Saved as a calibration before anything can be rated; a failure only loses the ratings, not the call.
        calibrationRef.current = twinClient.calibrations.start
          .mutate({ slug, sessionId: active.sessionId })
          .then(({ calibrationId: id }) => (setCalibrationId(id), id))
          .catch((saveError) => {
            console.error("Could not save the calibration:", saveError);
            toast.error("Ratings in this call can't be saved.");
            return null;
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
  }, [room, slug, closeSession, twin]);

  // Start once on open; the ref stops React's dev double-mount from starting a second session.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Leaving the page mid-call still closes the session.
  useEffect(
    () => () => {
      if (!endingRef.current && connectionRef.current) void end("abandoned");
    },
    [end],
  );

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
        updateTurns((prev) => {
          const last = prev[prev.length - 1];
          // The agent re-sends a growing final for one utterance; keep it as one turn (as /talk does).
          if (!isYou && last?.speaker === "twin" && (last.text === text || text.startsWith(last.text))) {
            return [...prev.slice(0, -1), { ...last, text }];
          }
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

  const rate = (id: string, rating: Rating) => {
    updateTurns((prev) => prev.map((t) => (t.id === id ? { ...t, rating } : t)));
    const calibration = calibrationRef.current;
    if (!twin || !calibration) return;
    const turns = turnsRef.current;
    const turnIndex = turns.findIndex((t) => t.id === id);
    if (turnIndex < 0) return;
    const question = turns.slice(0, turnIndex).reverse().find((t) => t.speaker === "you")?.text ?? null;
    void calibration.then((calibrationId) => {
      if (!calibrationId) return;
      return twinClient.calibrations.rate
        .mutate({ calibrationId, turnIndex, question, reply: turns[turnIndex].text, rating })
        .catch((saveError) => {
          console.error("Could not save the rating:", saveError);
          toast.error("That rating was not saved.");
        });
    });
  };

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

  return (
    <LiveKitWorkspaceProvider
      sessionId={connection?.sessionId}
      runtimeToken={connection?.runtimeToken}
      onSurface={ignoreSurface}
      onEndSession={() => void end("completed")}
      active={phase === "live"}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Link href={backHref} className="flex w-fit items-center gap-2 px-8 pt-6 text-sm text-foreground/90 hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Calibrate · {scenarioName}
        </Link>

        {phase === "ended" ? (
          <CallSummary
            transcriptHref={
              twin
                ? calibrationId ? `/twin/${encodeURIComponent(slug)}/calibration/${encodeURIComponent(calibrationId)}` : undefined
                : connection?.sessionId ? `/sessions/${encodeURIComponent(connection.sessionId)}` : undefined
            }
            backHref={backHref}
            backLabel={twin ? "All calibrations" : "Go to Roleplay"}
            twinName={twinName}
            seconds={seconds}
            turns={turns}
            onRestart={() => void start()}
          />
        ) : (
          <>
            <div className={cn("flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-8 pb-32", panelOpen && "lg:pr-[440px]")}>
              <div className={cn("relative size-[320px] shrink-0 overflow-hidden rounded-[32px] bg-muted", SOFT_SHADOW, speaking && "ring-2 ring-emerald-500/70")}>
                <TwinPortrait name={twinName} className="size-full text-8xl" />
                <span className="absolute bottom-3 left-3 rounded-full bg-white px-2.5 py-1 text-[13px] leading-[18px] font-medium text-neutral-900 shadow-[0_0_0_1px_#e9e9e9]">
                  {twinName}
                </span>
                <span className="absolute right-3 bottom-3 rounded-full bg-black/45 px-2.5 py-1 text-[13px] leading-[18px] font-medium text-white tabular-nums">
                  <span className="sr-only">Call time </span>
                  {clock(seconds)}
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
                  captions.slice(-2).map((turn, index, shown) =>
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
                        {turn.streaming ? null : turn.rating ? (
                          <RatingLabel rating={turn.rating} className="text-[13px]" />
                        ) : (
                          <div className="flex gap-2">
                            <button type="button" className={PILL} onClick={() => rate(turn.id, "like")}>
                              <FeelsLikeMeIcon className="size-4" />
                              Feels like me
                            </button>
                            <button type="button" className={PILL} onClick={() => rate(turn.id, "off")}>
                              <FeelsOffIcon className="size-4" />
                              Feels off
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  )
                )}
              </div>
            </div>

            <div className={cn("absolute inset-x-0 bottom-6 flex justify-center gap-4", panelOpen && "lg:pr-[440px]")}>
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
                aria-label="View conversation"
                aria-pressed={panelOpen}
                onClick={() => setPanelOpen(!panelOpen)}
                style={{ "--call-chat-lines": panelOpen ? "var(--card)" : "var(--muted)" } as React.CSSProperties}
                className={cn(CONTROL, "border", panelOpen ? "bg-card" : "bg-muted hover:bg-border")}
              >
                <ChatIcon />
              </button>
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

            {panelOpen ? <ConversationPanel turns={turns} twinName={twinName} onClose={() => setPanelOpen(false)} /> : null}

            <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
              <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-6 rounded-3xl px-6 pt-8 pb-6">
                <AlertDialogTitle className="max-w-[300px] text-center text-xl leading-7 font-semibold tracking-[-0.015em]">
                  Do you want to end the conversation?
                </AlertDialogTitle>
                <div className="grid w-full grid-cols-2 gap-2">
                  <button type="button" className={cn(PILL, "h-10 justify-center px-4 text-sm")} onClick={() => void end("abandoned")}>
                    Yes, end the call
                  </button>
                  <AlertDialogCancel variant="default" className="h-10 rounded-full px-4 text-sm font-semibold">
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

/** Full transcript so far, in a floating panel (prototype "Conversation"). */
function ConversationPanel({ turns, twinName, onClose }: { turns: CalibrationTurn[]; twinName: string; onClose: () => void }) {
  return (
    <section
      aria-label="Conversation"
      className={cn(
        "absolute right-6 bottom-6 z-20 flex h-[450px] max-h-[calc(100%-3rem)] w-[360px] flex-col overflow-hidden rounded-2xl bg-card max-sm:inset-x-4 max-sm:w-auto",
        PANEL_SHADOW,
      )}
    >
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
      {turns.length === 0 ? (
        <p className="m-auto px-6 text-center text-sm text-muted-foreground">What you and {twinName} say appears here.</p>
      ) : (
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
      )}
    </section>
  );
}

/** After the call: how long it ran and how the answers were rated. */
function CallSummary({
  transcriptHref,
  backHref,
  backLabel,
  twinName,
  seconds,
  turns,
  onRestart,
}: {
  transcriptHref?: string;
  backHref: string;
  backLabel: string;
  twinName: string;
  seconds: number;
  turns: CalibrationTurn[];
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
        <Link href={backHref} className={cn(PILL, "h-10 px-4 text-sm")}>
          <RoleplayIcon className="size-[18px]" />
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
