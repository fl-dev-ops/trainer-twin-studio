"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LoaderCircle, Play, Upload as UploadIcon, X } from "lucide-react";
import "@livekit/components-styles";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
} from "@livekit/components-react";
import {
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
import { CodeEditor } from "@/components/session/code-editor";
import { Whiteboard } from "@/components/session/whiteboard";
import { PresentationViewer } from "@/components/session/presentation-viewer";
import { PdfViewerSurface } from "@/components/session/pdf-viewer";
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
  sessionCode?: string;
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
  sessionCode,
}: Props) {
  const [agent, setAgent] = useState(agents[0] ?? "");
  const persona = agentPersonas[agent] ?? personas[0] ?? "";
  const [contextId, setContextId] = useState("");
  const [contextList, setContextList] = useState<{ id: string; name: string; size?: number }[]>(contexts);
  const [uploadingContext, setUploadingContext] = useState(false);
  const contextInput = useRef<HTMLInputElement>(null);

  const [connection, setConnection] = useState<SessionConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const [endReason, setEndReason] = useState<EndReason>("disconnected");

  async function handleStartSession() {
    setError("");
    setConnecting(true);
    try {
      const launchResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          sessionCode
            ? { shareCode: sessionCode, contextId: contextId || undefined }
            : { agentSlug: agent, contextId: contextId || undefined },
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
      setError(e instanceof Error ? e.message : "Failed to start session");
    } finally {
      setConnecting(false);
    }
  }

  function handleEndSession(reason: EndReason) {
    setEndReason(reason);
    setConnection(null);
    setEnded(true);
  }

  if (ended) {
    return (
      <div className="dark flex h-dvh w-dvw items-center justify-center bg-background p-6 text-foreground">
        <Card className="w-full max-w-md text-center">
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
            <Button onClick={() => setEnded(false)}>
              <Play data-icon="inline-start" /> New session
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="dark flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground">
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
              <h1 className="truncate text-sm font-semibold tracking-tight">New session</h1>
              <p className="hidden text-[11px] text-muted-foreground sm:block">Practice session</p>
            </div>
          </div>
          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full bg-muted-foreground/50" />
            Disconnected
          </span>
        </header>

        <main className="relative flex min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
          <div className="mx-auto flex h-full w-full max-w-xl items-center">
            <Card className="w-full">
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
                <Button
                  onClick={handleStartSession}
                  disabled={!persona || !agent || connecting}
                  className="w-full"
                >
                  {connecting ? (
                    <>
                      <LoaderCircle className="animate-spin" /> Launching session…
                    </>
                  ) : (
                    <>
                      <Play data-icon="inline-start" /> Start session
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dark fixed inset-0 z-50 flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground">
      <LiveKitRoom
        serverUrl={connection.url}
        token={connection.token}
        connect={true}
        audio={true}
        video={false}
        options={{
          audioCaptureDefaults: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
          adaptiveStream: true,
          dynacast: true,
        }}
        onError={(err) => setError(err.message)}
        onDisconnected={() => handleEndSession("disconnected")}
        data-lk-theme="default"
        className="flex h-full w-full flex-1 flex-col overflow-hidden"
        style={{ height: "100%", width: "100%" }}
      >
        <RoomAudioRenderer />
        <ActiveSession
          agent={agent}
          persona={persona}
          connection={connection}
          onEndSession={handleEndSession}
        />
      </LiveKitRoom>
    </div>
  );
}

function ActiveSession({
  agent,
  persona,
  connection,
  onEndSession,
}: {
  agent: string;
  persona: string;
  connection: SessionConnection;
  onEndSession: (reason: EndReason) => void;
}) {
  const room = useRoomContext();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [coverage, setCoverage] = useState<Coverage>({});
  const [interviewReady, setInterviewReady] = useState(false);
  const [surface, setSurface] = useState<AgentSurface>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const finalizedRef = useRef(false);
  const reduceMotion = useReducedMotion();

  entriesRef.current = entries;
  coverageRef.current = coverage;

  const layoutTransition = reduceMotion
    ? ({ duration: 0 } as const)
    : ({ type: "spring", stiffness: 300, damping: 32, mass: 0.8 } as const);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  function finalizeSession(status: "completed" | "abandoned") {
    if (finalizedRef.current) return;
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
  }

  async function handleDisconnect(reason: EndReason = "manual") {
    finalizeSession(reason === "completed" ? "completed" : "abandoned");
    await room.disconnect().catch(() => {});
    onEndSession(reason);
  }

  useEffect(() => {
    function handleTranscription(segments: TranscriptionSegment[], participant: any) {
      const isUser = participant?.identity === room.localParticipant.identity;
      for (const seg of segments) {
        if (!seg.final) continue;
        const role = isUser ? ("user" as const) : ("trainer" as const);
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

        if (!isUser && connection.sessionId) {
          void fetch(`/api/sessions/${connection.sessionId}`, {
            headers: connection.runtimeToken
              ? { Authorization: `Bearer ${connection.runtimeToken}` }
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
        if (data.type === "session-started") {
          setInterviewReady(true);
        } else if (data.type === "session-ended" && data.status === "completed") {
          void handleDisconnect("completed");
        } else if (data.type === "interview_question_started") {
          setInterviewReady(true);
          const metadata = data.metadata as { question?: { spokenText?: string } } | undefined;
          if (metadata?.question?.spokenText) {
            const spoken = metadata.question.spokenText;
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
      finalizeSession("abandoned");
      onEndSession("disconnected");
    }

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);
    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.Disconnected, handleRoomDisconnected);

    return () => {
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.Disconnected, handleRoomDisconnected);
    };
  }, [room, connection, onEndSession]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <LiveKitWorkspaceProvider
      room={room}
      onSurface={setSurface}
      onEndSession={() => void handleDisconnect("completed")}
    >
      <div className="flex h-full w-full flex-1 flex-col overflow-hidden">
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
              {persona} × {agent}
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">Practice session</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <time className="font-mono text-xs text-muted-foreground">{mm}:{ss}</time>
          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                interviewReady ? "bg-emerald-500" : "animate-pulse bg-amber-500",
              )}
            />
            {interviewReady ? "Connected" : "Preparing…"}
          </span>
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        <div className="flex h-full min-h-0 w-full gap-4">
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
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
                        <CodeEditor
                          key={surface.key}
                          initialLanguage={surface.language}
                          initialCode={surface.starterCode || undefined}
                        />
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
                  <AgentTile persona={persona} compact={surface !== null} />
                </motion.div>
                <motion.div layout transition={layoutTransition} className="min-h-0">
                  <CandidateTile compact={surface !== null} />
                </motion.div>
              </motion.div>
            </motion.div>
          </div>

          <AnimatePresence initial={false}>
            {sidebarOpen && (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: 24 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className="absolute inset-3 z-20 xl:static xl:inset-auto xl:z-auto xl:w-[22rem] xl:shrink-0"
              >
                <SessionSidebar
                  entries={entries}
                  coverage={coverage}
                  preparing={!interviewReady}
                  onClose={() => setSidebarOpen(false)}
                  className="h-full"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="session-footer flex shrink-0 items-center justify-center px-4 py-3">
        <SessionControlBar
          isConnected={true}
          transcriptOpen={sidebarOpen}
          onTranscriptToggle={setSidebarOpen}
          onEnd={() => void handleDisconnect("manual")}
        />
      </footer>
      </div>
    </LiveKitWorkspaceProvider>
  );
}
