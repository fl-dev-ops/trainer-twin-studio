"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LoaderCircle, Play, Upload as UploadIcon, X } from "lucide-react";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteTrack,
  type RemoteParticipant,
  type TranscriptionSegment,
} from "livekit-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentTile } from "@/components/session/agent-tile";
import { CandidateTile } from "@/components/session/candidate-tile";
import { SessionControlBar } from "@/components/session/session-control-bar";
import { TranscriptPanel } from "@/components/session/transcript-panel";
import { CodeEditor } from "@/components/session/code-editor";
import { Whiteboard } from "@/components/session/whiteboard";
import { PresentationViewer } from "@/components/session/presentation-viewer";
import { PdfViewerSurface } from "@/components/session/pdf-viewer";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import type { AgentSurface } from "@/lib/agent-surface-events";
import type { Entry } from "@/lib/session-transcript";
import type { VisualizerState } from "@/components/session/visualizer-bar";
import { cn } from "@/lib/utils";

type Coverage = Record<string, string>;
type EndReason = "completed" | "manual" | "disconnected";

type Props = {
  personas: string[];
  agents: string[];
  contexts: { id: string; name: string; size?: number }[];
  agentPersonas?: Record<string, string>;
  sessionCode?: string;
};

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:7860";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SessionView({ personas, agents, contexts, agentPersonas = {}, sessionCode }: Props) {
  const [agent, setAgent] = useState(agents[0] ?? "");
  const persona = agentPersonas[agent] ?? personas[0] ?? "";
  const [contextId, setContextId] = useState("");
  const [contextList, setContextList] = useState<{ id: string; name: string; size?: number }[]>(contexts);
  const [uploadingContext, setUploadingContext] = useState(false);
  const contextInput = useRef<HTMLInputElement>(null);
  const [state_, setState_] = useState<"disconnected" | "connecting" | "connected" | "ready" | "error">("disconnected");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [micOn, setMicOn] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [interviewReady, setInterviewReady] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [localLevel, setLocalLevel] = useState(0);
  const [remoteLevel, setRemoteLevel] = useState(0);
  const [surface, setSurface] = useState<AgentSurface>(null);
  const [ended, setEnded] = useState(false);
  const [endReason, setEndReason] = useState<EndReason>("disconnected");
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const roomRef = useRef<Room | null>(null);
  const [livekitRoom, setLiveKitRoom] = useState<Room | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Mirrors of entries/coverage for the finalize call on disconnect.
  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const sessionRef = useRef<string | null>(null);
  const disconnectReasonRef = useRef<EndReason | "error">("disconnected");

  const connected = state_ !== "disconnected" && state_ !== "error";
  const preparing = connected && (state_ !== "ready" || !interviewReady);
  const reduceMotion = useReducedMotion();

  const agentState: VisualizerState = !connected
    ? "connecting"
    : preparing
      ? "thinking"
      : botSpeaking
        ? "speaking"
        : "listening";

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
      audio?.pause();
    };
  }, []);

  async function playRemoteAudio() {
    try {
      await audioRef.current?.play();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  }

  async function connect() {
    setError("");
    setAudioBlocked(false);
    setInterviewReady(false);
    setBotSpeaking(false);
    setMicOn(true);
    setLocalLevel(0);
    setRemoteLevel(0);
    setEnded(false);
    disconnectReasonRef.current = "disconnected";
    setEntries([]);
    entriesRef.current = [];
    setCoverage({});
    coverageRef.current = {};
    sessionRef.current = null;
    setElapsed(0);
    setTranscriptOpen(true);

    const launchResponse = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionCode
        ? { shareCode: sessionCode, contextId: contextId || undefined }
        : { agentSlug: agent, contextId: contextId || undefined }),
    });
    const launch = await launchResponse.json().catch(() => ({}));
    if (!launchResponse.ok || !launch.session?.id || !launch.session?.runtimeToken) {
      setError(launch.error ?? "Could not create session");
      return;
    }
    sessionRef.current = launch.session.id;

    const transport = null;
    if (!launch.livekit?.url || !launch.livekit?.token) {
      setError("LiveKit credentials not returned by server");
      return;
    }

    setState_("connecting");

    const room = new Room({
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      adaptiveStream: true,
      dynacast: true,
    });
    roomRef.current = room;
    setLiveKitRoom(room);

    room.on(RoomEvent.ConnectionStateChanged, (connectionState: ConnectionState) => {
      if (connectionState === ConnectionState.Connecting) {
        setState_("connecting");
      } else if (connectionState === ConnectionState.Connected) {
        setState_("ready");
      } else if (connectionState === ConnectionState.Disconnected) {
        setState_("disconnected");
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio && audioRef.current) {
        track.attach(audioRef.current);
        void playRemoteAudio();
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (audioRef.current) {
        track.detach(audioRef.current);
      }
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const isAgentSpeaking = speakers.some((s) => s.identity !== room.localParticipant.identity);
      setBotSpeaking(isAgentSpeaking);

      const localSpeaker = speakers.find((s) => s.identity === room.localParticipant.identity);
      const remoteSpeaker = speakers.find((s) => s.identity !== room.localParticipant.identity);
      setLocalLevel(localSpeaker ? Math.min(1, Math.max(0, localSpeaker.audioLevel)) : 0);
      setRemoteLevel(remoteSpeaker ? Math.min(1, Math.max(0, remoteSpeaker.audioLevel)) : 0);
    });

    room.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant) => {
      const isUser = participant?.identity === room.localParticipant.identity;
      for (const seg of segments) {
        if (!seg.final) continue;
        const role = isUser ? ("user" as const) : ("trainer" as const);
        setEntries((prev) => {
          const next = [...prev, { role, text: seg.text }];
          entriesRef.current = next;
          return next;
        });

        // Fetch authoritative coverage & state snapshot from web runtime
        if (!isUser && sessionRef.current) {
          void fetch(`/api/sessions/${sessionRef.current}`, {
            headers: launch.session.runtimeToken
              ? { Authorization: `Bearer ${launch.session.runtimeToken}` }
              : {},
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((snap) => {
              if (snap?.coverage) {
                setCoverage(snap.coverage);
                coverageRef.current = snap.coverage;
              }
            })
            .catch(() => {});
        }
      }
    });

    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      try {
        const text = new TextDecoder().decode(payload);
        const data = JSON.parse(text) as Record<string, unknown>;
        if (data.type === "session-started") {
          setInterviewReady(true);
        } else if (data.type === "session-ended" && data.status === "completed") {
          disconnectReasonRef.current = "completed";
          void room.disconnect();
        } else if (data.type === "interview_question_started") {
          setInterviewReady(true);
          const metadata = data.metadata as { question?: { spokenText?: string } } | undefined;
          if (metadata?.question?.spokenText) {
            const spoken = metadata.question.spokenText;
            setEntries((prev) => {
              const next = [...prev, { role: "trainer" as const, text: spoken }];
              entriesRef.current = next;
              return next;
            });
          }
        }
      } catch {}
    });

    room.on(RoomEvent.Disconnected, () => {
      const reason = disconnectReasonRef.current;
      setInterviewReady(false);
      setBotSpeaking(false);
      setSurface(null);
      setState_("disconnected");
      setLiveKitRoom(null);
      roomRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.srcObject = null;
      }
      if (reason !== "error") {
        setEndReason(reason);
        setEnded(true);
      }
      // Persist what the browser captured before the socket died.
      if (sessionRef.current) {
        void fetch("/api/sessions/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionRef.current,
            transcript: entriesRef.current,
            evidence: coverageRef.current,
          }),
          keepalive: true,
        }).catch(() => {});
        sessionRef.current = null;
      }
    });

    try {
      await room.connect(launch.livekit.url, launch.livekit.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setInterviewReady(true);
    } catch (e) {
      disconnectReasonRef.current = "error";
      setError(e instanceof Error ? e.message : "Failed to connect to LiveKit");
      await room.disconnect().catch(() => {});
      roomRef.current = null;
      setLiveKitRoom(null);
      setState_("disconnected");
    }
  }

  async function disconnect() {
    disconnectReasonRef.current = "manual";
    if (roomRef.current) {
      await roomRef.current.disconnect().catch(() => {});
      roomRef.current = null;
    }
    setLiveKitRoom(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
    setAudioBlocked(false);
    setInterviewReady(false);
    setBotSpeaking(false);
    setState_("disconnected");
    setEndReason("manual");
    setEnded(true);
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const layoutTransition = reduceMotion
    ? ({ duration: 0 } as const)
    : ({ type: "spring", stiffness: 300, damping: 32, mass: 0.8 } as const);

  if (ended) {
    return (
      <div className="dark flex h-dvh w-dvw items-center justify-center bg-background p-6 text-foreground">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>{endReason === "completed" ? "Session complete" : "Session ended"}</CardTitle>
            <CardDescription>
              {endReason === "disconnected"
                ? "The connection closed unexpectedly. Any captured session data is being saved."
                : "Your transcript and recording are being saved in Sessions."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center gap-2">
            <Button variant="outline" nativeButton={false} render={<Link href="/sessions" />}>
              View sessions
            </Button>
            <Button onClick={() => setEnded(false)}>
              <Play data-icon="inline-start" /> New session
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="dark flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground">
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      {/* header */}
      <header className="session-header flex shrink-0 items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Back to studio"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent"
          >
            <Image src="/trainertwin-mark.svg" alt="" width={20} height={15} priority />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">
              {connected ? `${persona} × ${agent}` : "New session"}
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">Practice session</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {connected && (
            <time className="font-mono text-xs text-muted-foreground">{mm}:{ss}</time>
          )}
          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                state_ === "ready" && interviewReady ? "bg-emerald-500" : "animate-pulse bg-amber-500",
              )}
            />
            {connected ? (preparing ? "Preparing…" : "Connected") : "Disconnected"}
          </span>
        </div>
      </header>

      {/* main */}
      <main className="relative flex min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        {connected && error && (
          <p role="alert" className="absolute inset-x-4 top-4 z-30 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {!connected ? (
          <div className="mx-auto flex h-full w-full max-w-xl items-center">
            <Card className="w-full">
              <CardHeader>
                <CardTitle>Configure the session</CardTitle>
                <CardDescription>
                  Choose a scenario. Its trainer persona is already configured ({AGENT_URL}).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">Scenario</span>
                  <Select value={agent} onValueChange={(v) => v !== null && setAgent(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Scenario" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Scenarios</SelectLabel>
                        {agents.map((a) => (
                          <SelectItem key={a} value={a}>{a}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">Context document</span>
                  <div className="flex items-center gap-2">
                    <Select value={contextId || "none"} onValueChange={(v) => v !== null && setContextId(v === "none" ? "" : v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Uploaded contexts</SelectLabel>
                          <SelectItem value="none">None</SelectItem>
                          {contextList.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name} · {formatBytes(c.size ?? 0)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <input
                      ref={contextInput}
                      type="file"
                      accept=".md,.txt,.pdf"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        setUploadingContext(true);
                        setError("");
                        try {
                          const form = new FormData();
                          form.append("file", file);
                          const res = await fetch("/api/upload", { method: "POST", body: form });
                          const data = await res.json().catch(() => null);
                          if (!res.ok) throw new Error(data?.error ?? "Upload failed");
                          setContextList((prev) => [
                            ...prev,
                            { id: data.id, name: data.name, size: file.size },
                          ]);
                          setContextId(data.id);
                        } catch (uploadError) {
                          setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
                        } finally {
                          setUploadingContext(false);
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      aria-label="Upload context document"
                      disabled={uploadingContext}
                      onClick={() => contextInput.current?.click()}
                    >
                      {uploadingContext ? <LoaderCircle className="animate-spin" /> : <UploadIcon />}
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Résumé or reference doc (.pdf, .md, .txt) uploaded right before the session.
                  </span>
                </label>
                {error && (
                  <p role="alert" className="text-sm text-destructive">{error}</p>
                )}
                <Button onClick={connect} disabled={!persona || !agent} className="w-full">
                  <Play data-icon="inline-start" /> Start session
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          livekitRoom && (
            <LiveKitWorkspaceProvider room={livekitRoom} onSurface={setSurface}>
              <div className="flex min-h-0 w-full gap-4">
                <div className="min-h-0 min-w-0 flex-1">
                  <motion.div
                    layout
                    data-has-surface={surface !== null}
                    transition={layoutTransition}
                    className="interview-stage h-full min-h-0 gap-4"
                  >
                    <AnimatePresence initial={false} mode="wait">
                      {surface && (
                        <motion.section
                          key={surface.key}
                          aria-label="Session workspace"
                          layout
                          initial={reduceMotion ? false : { opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
                          transition={reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                          className="interview-surface flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border"
                        >
                          <div className="flex h-10 shrink-0 items-center justify-end border-b px-2">
                            <Button variant="ghost" size="icon-sm" aria-label="Close workspace" onClick={() => setSurface(null)}>
                              <X />
                            </Button>
                          </div>
                          <div className="min-h-0 flex-1">
                            {surface.tool === "code" && (
                              <CodeEditor key={surface.key} initialLanguage={surface.language} initialCode={surface.starterCode || undefined} />
                            )}
                            {surface.tool === "canvas" && <Whiteboard key={surface.key} />}
                            {surface.tool === "pdf" && (
                              <PdfViewerSurface key={surface.key} sourceUrl={surface.sourceUrl} />
                            )}
                            {surface.tool === "presentation" && (
                              <PresentationViewer key={surface.key} sourceUrl={surface.sourceUrl} />
                            )}
                          </div>
                        </motion.section>
                      )}
                    </AnimatePresence>

                    <motion.div
                      layout
                      data-compact={surface !== null}
                      transition={layoutTransition}
                      className="interview-participants min-h-0 gap-4"
                    >
                      <motion.div layout transition={layoutTransition} className="min-h-0">
                        <AgentTile persona={persona} state={agentState} level={remoteLevel} compact={surface !== null} />
                      </motion.div>
                      <motion.div layout transition={layoutTransition} className="min-h-0">
                        <CandidateTile level={localLevel} micOn={micOn} compact={surface !== null} />
                      </motion.div>
                    </motion.div>
                  </motion.div>
                </div>

                <AnimatePresence initial={false}>
                  {transcriptOpen && (
                    <motion.div
                      initial={reduceMotion ? false : { opacity: 0, x: 24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={reduceMotion ? undefined : { opacity: 0, x: 24 }}
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                      className="absolute inset-3 z-20 xl:static xl:inset-auto xl:z-auto xl:w-[22rem] xl:shrink-0"
                    >
                      <TranscriptPanel
                        entries={entries}
                        coverage={coverage}
                        preparing={preparing}
                        onClose={() => setTranscriptOpen(false)}
                        className="h-full"
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </LiveKitWorkspaceProvider>
          )
        )}
      </main>

      {/* footer controls */}
      <footer className="session-footer flex shrink-0 items-center justify-center px-4 py-3">
        <SessionControlBar
          audioBlocked={audioBlocked}
          isConnected={connected}
          micOn={micOn}
          transcriptOpen={transcriptOpen}
          onEnableAudio={playRemoteAudio}
          onMicToggle={toggleMic}
          onTranscriptToggle={setTranscriptOpen}
          onEnd={disconnect}
        />
      </footer>
    </div>
  );
}
