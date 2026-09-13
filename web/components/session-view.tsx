"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LoaderCircle, Play, Upload as UploadIcon, Volume2, X } from "lucide-react";
import "@livekit/components-styles";
import {
  RoomAudioRenderer,
  RoomContext,
} from "@livekit/components-react";
import {
  Room,
  RoomEvent,
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
import { SessionSidebar } from "@/components/session/session-sidebar";
import { LiveSubtitles } from "@/components/session/live-subtitles";
import { CodeEditor } from "@/components/session/code-editor";
import { Whiteboard } from "@/components/session/whiteboard";
import { PresentationViewer } from "@/components/session/presentation-viewer";
import { PdfViewerSurface } from "@/components/session/pdf-viewer";
import { ImageViewerSurface } from "@/components/session/image-viewer";
import { LiveKitWorkspaceProvider } from "@/lib/livekit-workspaces";
import type { AgentSurface } from "@/lib/agent-surface-events";
import type { Entry } from "@/lib/session-transcript";
import { cn } from "@/lib/utils";

type Coverage = Record<string, string>;
type EndReason = "completed" | "manual" | "disconnected";

type SessionConnection = {
  url: string;
  token: string;
  sessionId: string;
  runtimeToken: string;
};

type Props = {
  personas: string[];
  agents: string[];
  contexts: { id: string; name: string; size?: number }[];
  agentPersonas?: Record<string, string>;
  agentContextRequired?: Record<string, boolean>;
  sessionCode?: string;
  /** Playable intro video per scenario slug. */
  introVideos?: Record<string, string | null>;
  /** Learner-facing entries: no start button, the session starts on page load. */
  autoStart?: boolean;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SessionView({
  personas,
  agents,
  contexts,
  agentPersonas = {},
  agentContextRequired = {},
  sessionCode,
  introVideos = {},
  autoStart = false,
}: Props) {
  // One stable Room instance for the whole mount
  const room = useMemo(
    () =>
      new Room({
        adaptiveStream: true,
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      }),
    [],
  );

  const [agent, setAgent] = useState(agents[0] ?? "");
  const persona = agentPersonas[agent] ?? personas[0] ?? "";
  const [contextIds, setContextIds] = useState<string[]>([]);
  const contextId = contextIds[0] ?? "";
  const [contextList, setContextList] = useState<{ id: string; name: string; size?: number }[]>(contexts);
  const [uploadingContext, setUploadingContext] = useState(false);
  const contextInput = useRef<HTMLInputElement>(null);

  const [launched, setLaunched] = useState(false);
  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentInRoom, setAgentInRoom] = useState(false);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const [endReason, setEndReason] = useState<EndReason>("disconnected");
  const [introDone, setIntroDone] = useState(false);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [surface, setSurface] = useState<AgentSurface>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [subtitlesActive, setSubtitlesActive] = useState(true);
  const [latestSpokenText, setLatestSpokenText] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const reduceMotion = useReducedMotion();

  const startedRef = useRef(false);
  const releasedRef = useRef(false);
  const endingRef = useRef(false);
  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const finalizedRef = useRef(false);

  useEffect(() => {
    entriesRef.current = entries;
    coverageRef.current = coverage;
  }, [entries, coverage]);

  const introSrc = introVideos[agent] ?? null;

  const resetSessionState = useCallback(() => {
    startedRef.current = false;
    releasedRef.current = false;
    endingRef.current = false;
    finalizedRef.current = false;
    setConnection(null);
    setConnected(false);
    setLaunched(false);
    setAgentInRoom(false);
    setError("");
    setEndReason("disconnected");
    setIntroDone(false);
    setEntries([]);
    setCoverage({});
    setSurface(null);
    setLatestSpokenText("");
    setElapsed(0);
  }, []);

  const handleStartSession = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError("");
    try {
      const launchResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          sessionCode
            ? { shareCode: sessionCode, contextId: contextId || undefined, contextIds }
            : { agentSlug: agent, contextId: contextId || undefined, contextIds },
        ),
      });
      const launch = await launchResponse.json().catch(() => ({}));
      if (!launchResponse.ok || !launch.session?.id || !launch.session?.runtimeToken) {
        throw new Error(launch.error ?? "Could not create session");
      }
      if (!launch.livekit?.url || !launch.livekit?.token) {
        throw new Error(launch.livekitError ?? "LiveKit credentials not returned by server");
      }

      setConnection({
        url: launch.livekit.url,
        token: launch.livekit.token,
        sessionId: launch.session.id,
        runtimeToken: launch.session.runtimeToken,
      });
    } catch (e) {
      startedRef.current = false;
      setError(e instanceof Error ? e.message : "Failed to start session");
      if (!autoStart) setLaunched(false);
    }
  }, [agent, contextId, contextIds, sessionCode, autoStart]);

  const handleRetry = useCallback(() => {
    startedRef.current = false;
    setError("");
    void handleStartSession();
  }, [handleStartSession]);

  const isContextRequired = Boolean(agentContextRequired[agent]);

  useEffect(() => {
    if (!autoStart || ended || !agent || !persona || launched) return;
    if (isContextRequired && contextIds.length === 0) return;
    void Promise.resolve().then(() => {
      setLaunched(true);
      void handleStartSession();
    });
  }, [autoStart, ended, agent, persona, launched, isContextRequired, contextIds, handleStartSession]);

  useEffect(() => {
    if (!connection || connected) return;
    let cancelled = false;
    room
      .connect(connection.url, connection.token)
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("LiveKit connect failed:", e);
        setError("Could not connect to the session. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [room, connection, connected]);

  useEffect(() => {
    if (!connected) return;
    const markAgent = () => setAgentInRoom(true);
    if (room.remoteParticipants.size > 0) {
      markAgent();
      return;
    }
    room.on(RoomEvent.ParticipantConnected, markAgent);
    return () => {
      room.off(RoomEvent.ParticipantConnected, markAgent);
    };
  }, [room, connected]);

  useEffect(() => {
    if (!connected || !agentInRoom || ended) return;
    if (introSrc && !introDone) return;
    if (releasedRef.current) return;
    releasedRef.current = true;
    void (async () => {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (micError) {
        console.error("Could not enable microphone:", micError);
      }
      try {
        await room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ type: "begin-opening" })),
          { reliable: true },
        );
      } catch (dataError) {
        console.error("Could not release agent opening:", dataError);
      }
    })();
  }, [room, connected, agentInRoom, ended, introSrc, introDone]);

  const finalizeSession = useCallback(
    (status: "completed" | "abandoned") => {
      if (finalizedRef.current || !connection) return;
      finalizedRef.current = true;
      void fetch("/api/sessions/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: connection.sessionId,
          status,
          transcript: entriesRef.current,
          evidence: coverageRef.current,
        }),
        keepalive: true,
      }).catch(() => {});
    },
    [connection],
  );

  const handleDisconnect = useCallback(
    async (reason: EndReason) => {
      endingRef.current = true;
      finalizeSession(reason === "completed" ? "completed" : "abandoned");
      await room.disconnect().catch(() => {});
      resetSessionState();
      setEndReason(reason);
      setEnded(true);
    },
    [room, finalizeSession, resetSessionState],
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setEntries((prev) => [...prev, { role: "user" as const, text }]);
      try {
        await room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ type: "chat-message", text })),
          { reliable: true },
        );
      } catch (err) {
        console.error("Could not send chat message:", err);
      }
    },
    [room],
  );

  useEffect(() => {
    if (!connection) return;
    const activeConnection = connection;

    function handleTranscription(segments: TranscriptionSegment[], participant: { identity?: string } | undefined) {
      const isUser = participant?.identity === room.localParticipant.identity;
      for (const seg of segments) {
        if (!seg.final) continue;
        const role = isUser ? ("user" as const) : ("trainer" as const);
        if (!isUser && seg.text) {
          setLatestSpokenText(seg.text);
        }
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (role === "trainer" && last?.role === "trainer" && (last.text === seg.text || seg.text.startsWith(last.text))) {
            const next = [...prev.slice(0, -1), { role, text: seg.text }];
            entriesRef.current = next;
            return next;
          }
          const next = [...prev, { role, text: seg.text }];
          entriesRef.current = next;
          return next;
        });

        if (!isUser && activeConnection.sessionId) {
          void fetch(`/api/sessions/${activeConnection.sessionId}`, {
            headers: activeConnection.runtimeToken
              ? { Authorization: `Bearer ${activeConnection.runtimeToken}` }
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
    }

    function handleData(payload: Uint8Array) {
      try {
        const text = new TextDecoder().decode(payload);
        const data = JSON.parse(text) as Record<string, unknown>;
        if (data.type === "session-ended" && data.status === "completed") {
          void handleDisconnect("completed");
        } else if (data.type === "interview_question_started") {
          const metadata = data.metadata as { question?: { spokenText?: string } } | undefined;
          if (metadata?.question?.spokenText) {
            const spoken = metadata.question.spokenText;
            setLatestSpokenText(spoken);
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "trainer" && last.text === spoken) return prev;
              const next = [...prev, { role: "trainer" as const, text: spoken }];
              entriesRef.current = next;
              return next;
            });
          }
        }
      } catch {}
    }

    function handleRoomDisconnected() {
      if (endingRef.current) return;
      finalizeSession("abandoned");
      resetSessionState();
      setEndReason("disconnected");
      setEnded(true);
    }

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);
    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.Disconnected, handleRoomDisconnected);

    return () => {
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.Disconnected, handleRoomDisconnected);
    };
  }, [room, connection, handleDisconnect, finalizeSession, resetSessionState]);

  useEffect(() => {
    if (!launched || ended) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [launched, ended]);

  useEffect(() => {
    return () => {
      void room.disconnect().catch(() => {});
    };
  }, [room]);

  if (ended) {
    return (
      <div className="dark flex h-dvh w-dvw items-center justify-center bg-[#14161a] p-6 text-foreground">
        <Card className="w-full max-w-md border border-white/[0.06] bg-[#1c1f26] text-center shadow-2xl">
          <CardHeader>
            <CardTitle>{endReason === "completed" ? "Session complete" : "Session ended"}</CardTitle>
            <CardDescription>
              {endReason === "disconnected"
                ? "The connection closed unexpectedly. Any captured session data has been saved."
                : "Your transcript and recording are being saved in Sessions."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center gap-2">
            <Button variant="outline" nativeButton={false} render={<Link href="/sessions" />}>
              View sessions
            </Button>
            <Button
              onClick={() => {
                resetSessionState();
                setEnded(false);
              }}
            >
              <Play data-icon="inline-start" /> New session
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!launched) {
    return (
      <div className="dark flex h-dvh w-dvw flex-col overflow-hidden bg-[#14161a] text-foreground">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.035] bg-[#14161a]/85 px-6 backdrop-blur-xl">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority />
            <span className="font-bold text-lg tracking-tight text-white">TrainerTwin</span>
          </Link>
        </header>

        <main className="relative flex min-h-0 flex-1 overflow-hidden p-4 sm:p-6">
          <div className="mx-auto flex h-full w-full max-w-xl items-center">
            <Card className="w-full border border-white/[0.06] bg-[#1c1f26] shadow-2xl">
              <CardHeader>
                <CardTitle>Configure the session</CardTitle>
                <CardDescription>
                  Choose a scenario. Its trainer persona is already configured.
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
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Context document</span>
                    {isContextRequired && (
                      <span className="text-[11px] font-medium text-amber-500">
                        Required for this scenario
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={contextId || "none"}
                      onValueChange={(v) => {
                        if (!v || v === "none") setContextIds([]);
                        else setContextIds([v]);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select document" />
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
                      accept=".md,.txt,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.csv,.json,.png,.jpg,.jpeg,.webp"
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
                          // Single-selection: newly uploaded file becomes the selected document
                          setContextIds([data.id]);
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
                    PDF, Word, PPT, Excel, CSV, text, or images (.pdf, .docx, .pptx, etc.).
                  </span>
                </label>

                {error && (
                  <p role="alert" className="text-sm text-destructive">{error}</p>
                )}

                <Button
                  onClick={() => {
                    setLaunched(true);
                    void handleStartSession();
                  }}
                  disabled={!persona || !agent || (isContextRequired && contextIds.length === 0)}
                  className="w-full"
                >
                  <Play data-icon="inline-start" /> Start session
                </Button>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="dark flex h-dvh w-dvw flex-col overflow-hidden bg-[#14161a] text-foreground">
      <RoomContext.Provider value={room}>
        <LiveKitWorkspaceProvider
          room={room}
          onSurface={setSurface}
          onEndSession={() => void handleDisconnect("completed")}
        >
          {/* Topbar Navigation: Clean Logo Left, Live Badge Right */}
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.035] bg-[#14161a]/85 px-6 backdrop-blur-xl">
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/trainertwin-mark.svg" alt="" width={22} height={17} priority />
              <span className="font-bold text-lg tracking-tight text-white">TrainerTwin</span>
            </Link>

            <div className="flex items-center gap-2 rounded-full bg-[#e03b3b] px-3 py-1 font-semibold text-white text-xs shadow-sm">
              <span className="size-1.5 animate-pulse rounded-full bg-white" />
              <span>Live</span>
              <time className="font-mono text-xs font-semibold">{elapsedLabel}</time>
            </div>
          </header>

          {/* Main Body: Stage (Left) & Chat Sidebar (Right) — EQUAL HEIGHT */}
          <main className="flex min-h-0 flex-1 gap-4 p-4 pb-2">
            {/* Stage Section */}
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-h-0 w-full gap-4 transition-all duration-300">
                {/* Surface Presentation Mode (Left Large Workspace) */}
                {surface && (
                  <motion.section
                    key={surface.key}
                    aria-label="Session workspace"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.035] bg-[#15181f]"
                  >
                    <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.035] bg-white/[0.02] px-4">
                      <span className="text-xs font-semibold text-foreground/90">
                        {surface.tool === "code" && "Code Workspace"}
                        {surface.tool === "canvas" && "Whiteboard"}
                        {surface.tool === "pdf" && "PDF Document"}
                        {surface.tool === "image" && "Image Viewer"}
                        {surface.tool === "presentation" && "Presentation"}
                      </span>
                      <Button variant="ghost" size="icon-sm" aria-label="Close workspace" onClick={() => setSurface(null)}>
                        <X className="size-4" />
                      </Button>
                    </div>
                    <div className="min-h-0 flex-1">
                      {surface.tool === "code" && (
                        <CodeEditor
                          key={surface.key}
                          initialLanguage={surface.language}
                          initialCode={surface.starterCode || undefined}
                          highlightLines={surface.highlightLines}
                        />
                      )}
                      {surface.tool === "canvas" && <Whiteboard key={surface.key} />}
                      {surface.tool === "pdf" && (
                        <PdfViewerSurface
                          key={surface.key}
                          sourceUrl={
                            surface.sourceUrl
                              ? surface.sourceUrl.includes("sessionId=")
                                ? surface.sourceUrl
                                : `${surface.sourceUrl}${surface.sourceUrl.includes("?") ? "&" : "?"}sessionId=${connection?.sessionId ?? ""}`
                              : undefined
                          }
                          initialPage={surface.page}
                          title={contextList.find((c) => c.id === surface.fileId)?.name}
                        />
                      )}
                      {surface.tool === "image" && (
                        <ImageViewerSurface
                          key={surface.key}
                          sourceUrl={
                            surface.sourceUrl
                              ? surface.sourceUrl.includes("sessionId=")
                                ? surface.sourceUrl
                                : `${surface.sourceUrl}${surface.sourceUrl.includes("?") ? "&" : "?"}sessionId=${connection?.sessionId ?? ""}`
                              : undefined
                          }
                          title={contextList.find((c) => c.id === surface.fileId)?.name}
                        />
                      )}
                      {surface.tool === "presentation" && (
                        <PresentationViewer
                          key={surface.key}
                          sourceUrl={surface.sourceUrl}
                          initialSlideNumber={surface.slideNumber}
                        />
                      )}
                    </div>
                  </motion.section>
                )}

                {/* Participant Tiles:
                    - Normal Mode: 2 equal side-by-side columns
                    - Presenting Mode: Stacked vertically on the right side!
                */}
                <div
                  className={cn(
                    surface ? "flex w-[280px] shrink-0 flex-col gap-3.5" : "grid flex-1 grid-cols-2 gap-4",
                    "min-h-0 transition-all duration-300",
                  )}
                >
                  <div className="min-h-0 flex-1">
                    {introSrc && !introDone ? (
                      <ScenarioIntro
                        key={agent}
                        src={introSrc}
                        personaLabel={persona}
                        onFinished={() => setIntroDone(true)}
                        className="h-full min-h-0 w-full"
                      />
                    ) : (
                      <AgentTile persona={persona} compact={surface !== null} />
                    )}
                  </div>
                  <div className="min-h-0 flex-1">
                    <CandidateTile compact={surface !== null} />
                  </div>
                </div>
              </div>

              {/* YouTube / Prime Video Style Streaming Subtitles */}
              <LiveSubtitles text={latestSpokenText} visible={subtitlesActive} />
            </div>

            {/* Chat Sidebar (Pure Chat, exact same height as stage!) */}
            <AnimatePresence initial={false}>
              {sidebarOpen && (
                <motion.div
                  initial={reduceMotion ? false : { opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 360 }}
                  exit={reduceMotion ? undefined : { opacity: 0, width: 0 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  className="shrink-0 overflow-hidden"
                >
                  <SessionSidebar
                    entries={entries}
                    onSendMessage={handleSendMessage}
                    onClose={() => setSidebarOpen(false)}
                    className="h-full"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </main>

          {/* Common Footer across full width */}
          <footer className="flex h-16 shrink-0 items-center justify-center pb-2">
            <SessionControlBar
              room={room}
              isConnected={connected}
              screenShareActive={surface !== null}
              onScreenShareToggle={() => {
                if (surface) setSurface(null);
                else setSurface({ tool: "code", key: "manual-share", language: "javascript", starterCode: "" });
              }}
              subtitlesActive={subtitlesActive}
              onSubtitlesToggle={() => setSubtitlesActive((v) => !v)}
              chatOpen={sidebarOpen}
              onChatToggle={() => setSidebarOpen((v) => !v)}
              onEnd={() => void handleDisconnect("manual")}
            />
          </footer>

          {error && (
            <div className="absolute inset-0 z-50 grid place-items-center bg-[#14161a]/85 p-6 backdrop-blur-md">
              <Card className="w-full max-w-md border border-white/[0.06] bg-[#1c1f26] text-center shadow-2xl">
                <CardHeader>
                  <CardTitle>Connection problem</CardTitle>
                  <CardDescription>{error}</CardDescription>
                </CardHeader>
                <CardContent className="flex justify-center gap-2">
                  {!autoStart && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        resetSessionState();
                        setLaunched(false);
                      }}
                    >
                      Back
                    </Button>
                  )}
                  <Button onClick={handleRetry}>Try again</Button>
                </CardContent>
              </Card>
            </div>
          )}
        </LiveKitWorkspaceProvider>
        <RoomAudioRenderer />
      </RoomContext.Provider>
    </div>
  );
}

function ScenarioIntro({
  src,
  personaLabel,
  onFinished,
  className,
}: {
  src: string;
  personaLabel?: string;
  onFinished?: () => void;
  className?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [releaseDeadline, setReleaseDeadline] = useState<number | null>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.play().catch(() => {
      el.muted = true;
      setMuted(true);
      el.play().catch(() => setNeedsTap(true));
    });
  }, [src]);

  useEffect(() => {
    if (releaseDeadline === null) return;
    const timer = window.setTimeout(() => onFinished?.(), Math.max(0, releaseDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [releaseDeadline, onFinished]);

  function armReleaseDeadline() {
    const el = video.current;
    if (!el) return;
    const remaining = Number.isFinite(el.duration) && el.duration > 0 ? el.duration - el.currentTime : 0;
    setReleaseDeadline(Date.now() + remaining * 1000 + 2000);
  }

  function playWithSound() {
    const el = video.current;
    if (!el) return;
    el.muted = false;
    setMuted(false);
    setNeedsTap(false);
    void el.play().catch(() => undefined);
  }

  return (
    <div className={cn("relative overflow-hidden rounded-2xl border border-white/[0.035] bg-black", className)}>
      <video
        ref={video}
        src={src}
        playsInline
        muted={muted}
        className="size-full object-contain"
        onEnded={onFinished}
        onError={() => onFinished?.()}
        onLoadedMetadata={armReleaseDeadline}
      />
      {personaLabel ? (
        <div className="absolute bottom-3.5 left-3.5 flex items-center gap-2 rounded-md bg-[#121419]/85 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur-md">
          <span className="font-medium text-foreground">
            {personaLabel.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Trainer"}
          </span>
          <span aria-hidden="true" className="size-1 rounded-full bg-border" />
          <span>Speaking</span>
        </div>
      ) : null}
      {needsTap ? (
        <button
          type="button"
          onClick={playWithSound}
          className="absolute inset-0 grid place-items-center bg-black/70"
        >
          <span className="flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 text-sm font-medium text-foreground">
            <Play className="size-4" /> Tap to play the introduction
          </span>
        </button>
      ) : muted ? (
        <button
          type="button"
          onClick={playWithSound}
          className="absolute right-3.5 bottom-3.5 flex items-center gap-2 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground"
        >
          <Volume2 className="size-3.5" /> Unmute
        </button>
      ) : null}
    </div>
  );
}
