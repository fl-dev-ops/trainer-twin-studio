"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LoaderCircle, Play, Upload as UploadIcon, X } from "lucide-react";
import {
  PipecatClient,
  RTVIEvent,
  type BotOutputData,
  type TranscriptData,
  type TransportState,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
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
import { PipecatWorkspaceProvider } from "@/lib/pipecat-workspaces";
import type { AgentSurface } from "@/lib/agent-surface-events";
import type { Entry } from "@/lib/session-transcript";
import type { VisualizerState } from "@/components/session/visualizer-bar";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api-url";
import { getClientBasePath, tenantLink } from "@/lib/tenant-link";
type Coverage = Record<string, string>;
type EndReason = "completed" | "manual" | "disconnected";

type Props = {
  personas: string[];
  agents: string[];
  contexts: { id: string; name: string; size?: number }[];
};

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:7860";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SessionView({ personas, agents, contexts }: Props) {
  const [persona, setPersona] = useState(personas[0] ?? "");
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [contextId, setContextId] = useState("");
  const [contextList, setContextList] = useState<{ id: string; name: string; size?: number }[]>(contexts);
  const [uploadingContext, setUploadingContext] = useState(false);
  const contextInput = useRef<HTMLInputElement>(null);
  const [state_, setState_] = useState<TransportState>("disconnected");
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
  const clientRef = useRef<PipecatClient | null>(null);
  const [rtviClient, setRtviClient] = useState<PipecatClient | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Mirrors of entries/coverage for the finalize call on disconnect.
  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const sessionRef = useRef<string | null>(null);
  const disconnectReasonRef = useRef<EndReason | "error">("disconnected");
  const launchTokenRef = useRef<string | null>(null);

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
      clientRef.current?.disconnect();
      clientRef.current = null;
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
    // Mint a scoped launch token bound to this learner + org (plan §2.6); the
    // agent verifies it before attaching the identity to the interview session.
    try {
      const startRes = await fetch(apiUrl("/api/sessions/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaSlug: persona, agentSlug: agent, contextId: contextId || undefined }),
      });
      const startData = await startRes.json().catch(() => null);
      if (!startRes.ok || !startData?.token) {
        throw new Error(startData?.error ?? "Could not start the session");
      }
      sessionRef.current = startData.session?.id ?? null;
      launchTokenRef.current = startData.token;
    } catch (startError) {
      disconnectReasonRef.current = "error";
      setError(startError instanceof Error ? startError.message : "Failed to start session");
      return;
    }
    setElapsed(0);
    setTranscriptOpen(true);
    const transport = new SmallWebRTCTransport({
      webrtcRequestParams: { endpoint: `${AGENT_URL}/api/offer` },
    });
    const client = new PipecatClient({
      transport,
      enableMic: true,
      callbacks: {
        onTransportStateChanged: (s) => setState_(s),
        onTrackStarted: (track) => {
          if (track.kind !== "audio" || !audioRef.current) return;
          audioRef.current.srcObject = new MediaStream([track]);
          void playRemoteAudio();
        },
        onError: (msg) => {
          disconnectReasonRef.current = "error";
          setError((msg.data as { message?: string } | undefined)?.message ?? "Connection error");
        },
        onUserTranscript: (data: TranscriptData) => {
          if (!data.final) return;
          setEntries((prev) => {
            entriesRef.current = [...prev, { role: "user" as const, text: data.text }];
            return entriesRef.current;
          });
        },
        onBotOutput: (data: BotOutputData) => {
          if (data.will_be_spoken === false) return;
          setEntries((prev) => {
            const last = prev[prev.length - 1];
            const next =
              last?.role === "trainer"
                ? [...prev.slice(0, -1), { role: "trainer" as const, text: data.text }]
                : [...prev, { role: "trainer" as const, text: data.text }];
            entriesRef.current = next;
            return next;
          });
        },
        onDisconnected: () => {
          const reason = disconnectReasonRef.current;
          setInterviewReady(false);
          setBotSpeaking(false);
          setSurface(null);
          setState_("disconnected");
          setRtviClient(null);
          clientRef.current = null;
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
            void fetch(apiUrl("/api/sessions/finalize"), {
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
        },
      },
    });
    clientRef.current = client;
    setRtviClient(client);

    client.on(RTVIEvent.BotStartedSpeaking, () => setBotSpeaking(true));
    client.on(RTVIEvent.BotStoppedSpeaking, () => setBotSpeaking(false));
    client.on(RTVIEvent.LocalAudioLevel, (level: number) =>
      setLocalLevel(Math.min(1, Math.max(0, level))));
    client.on(RTVIEvent.RemoteAudioLevel, (level: number) =>
      setRemoteLevel(Math.min(1, Math.max(0, level))));

    client.on(RTVIEvent.ServerMessage, (msg: {
      data?: {
        type?: string;
        error?: string;
        sessionId?: string;
        status?: string;
        state?: { coverage?: Coverage; phase_name?: string };
      };
    }) => {
      const payload = msg?.data;
      if (payload?.type === "session-started" && typeof payload.sessionId === "string") {
        sessionRef.current = payload.sessionId;
      } else if (payload?.type === "interview-state" && payload.state) {
        disconnectReasonRef.current = "disconnected";
        setCoverage(payload.state.coverage ?? {});
        coverageRef.current = payload.state.coverage ?? {};
        setInterviewReady(true);
      } else if (payload?.type === "session-ended" && payload.status === "completed") {
        disconnectReasonRef.current = "completed";
        void client.disconnect();
      } else if (payload?.type === "interview-error") {
        disconnectReasonRef.current = "error";
        setError(payload.error ?? "Failed to start session");
        void client.disconnect();
      }
    });

    try {
      await client.connect();
      client.sendClientMessage("start-interview", {
        personaId: persona,
        agentId: agent,
        contextId: contextId || undefined,
        launchToken: launchTokenRef.current ?? undefined,
      });
    } catch (e) {
      disconnectReasonRef.current = "error";
      setError(e instanceof Error ? e.message : "Failed to connect");
      await client.disconnect().catch(() => {});
      clientRef.current = null;
      setRtviClient(null);
      setState_("disconnected");
    }
  }

  async function disconnect() {
    disconnectReasonRef.current = "manual";
    await clientRef.current?.disconnect().catch(() => {});
    clientRef.current = null;
    setRtviClient(null);
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

  function toggleMic() {
    const client = clientRef.current;
    if (!client) return;
    const next = !micOn;
    client.enableMic(next);
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
            <Button variant="outline" nativeButton={false} render={<Link href={tenantLink("/sessions", getClientBasePath())} />}>
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
            href={tenantLink("/", getClientBasePath())}
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent"
          >
            <Image src={tenantLink("/trainertwin-mark.svg", getClientBasePath())} alt="" width={20} height={15} priority />
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
                  Pick a persona and scenario. The agent server must be running ({AGENT_URL}).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">Persona</span>
                  <Select value={persona} onValueChange={(v) => v !== null && setPersona(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Persona" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Personas</SelectLabel>
                        {personas.map((p) => (
                          <SelectItem key={p} value={p}>{p}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
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
                          const res = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
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
          rtviClient && (
            <PipecatWorkspaceProvider client={rtviClient} onSurface={setSurface}>
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
            </PipecatWorkspaceProvider>
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
