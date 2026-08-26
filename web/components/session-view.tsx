"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Code2,
  FileText,
  Mic,
  MicOff,
  PenLine,
  PhoneOff,
  Play,
  LoaderCircle,
  Presentation,
  Upload as UploadIcon,
  X,
} from "lucide-react";
import {
  PipecatClient,
  RTVIEvent,
  type BotOutputData,
  type TranscriptData,
  type TransportState,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { Badge } from "@/components/ui/badge";
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
import { ThemeToggle } from "@/components/theme-toggle";
import { CodeEditor } from "@/components/session/code-editor";
import { Whiteboard } from "@/components/session/whiteboard";
import { PresentationViewer } from "@/components/session/presentation-viewer";
import { PdfViewerSurface } from "@/components/session/pdf-viewer";
import { PipecatWorkspaceProvider } from "@/lib/pipecat-workspaces";
import type { AgentSurface } from "@/lib/agent-surface-events";
import { cn } from "@/lib/utils";

type Entry = { role: "user" | "trainer"; text: string };
type Coverage = Record<string, string>;

type Props = {
  personas: string[];
  agents: string[];
  contexts: { id: string; name: string }[];
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
  const [phaseName, setPhaseName] = useState("");
  const [micOn, setMicOn] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [interviewReady, setInterviewReady] = useState(false);
  const [surface, setSurface] = useState<AgentSurface>(null);
  const clientRef = useRef<PipecatClient | null>(null);
  const [rtviClient, setRtviClient] = useState<PipecatClient | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Mirrors of entries/coverage for the finalize call on disconnect.
  const entriesRef = useRef<Entry[]>([]);
  const coverageRef = useRef<Coverage>({});
  const sessionRef = useRef<string | null>(null);

  const connected = state_ !== "disconnected" && state_ !== "error";
  const preparing = connected && (state_ !== "ready" || !interviewReady);

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [entries]);

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
    setEntries([]);
    entriesRef.current = [];
    setCoverage({});
    coverageRef.current = {};
    sessionRef.current = null;
    setPhaseName("");
    setElapsed(0);
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
        onError: (msg) =>
          setError((msg.data as { message?: string } | undefined)?.message ?? "Connection error"),
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
          setInterviewReady(false);
          setSurface(null);
          setState_("disconnected");
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
        },
      },
    });
    clientRef.current = client;
    setRtviClient(client);

    client.on(RTVIEvent.ServerMessage, (msg: {
      data?: {
        type?: string;
        error?: string;
        sessionId?: string;
        state?: { coverage?: Coverage; phase_name?: string };
      };
    }) => {
      const payload = msg?.data;
      if (payload?.type === "session-started" && typeof payload.sessionId === "string") {
        sessionRef.current = payload.sessionId;
      } else if (payload?.type === "interview-state" && payload.state) {
        setCoverage(payload.state.coverage ?? {});
        coverageRef.current = payload.state.coverage ?? {};
        setPhaseName(payload.state.phase_name ?? "");
        setInterviewReady(true);
      } else if (payload?.type === "interview-error") {
        setError(payload.error ?? "Failed to start interview");
      }
    });

    try {
      await client.connect();
      client.sendClientMessage("start-interview", {
        personaId: persona,
        agentId: agent,
        contextId: contextId || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
      setState_("disconnected");
    }
  }

  async function disconnect() {
    await clientRef.current?.disconnect();
    clientRef.current = null;
    setRtviClient(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
    setAudioBlocked(false);
    setInterviewReady(false);
    setState_("disconnected");
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

  function renderTranscript(className: string) {
    return (
      <section
        aria-label="Session transcript"
        ref={transcriptRef}
        className={cn("overflow-y-auto rounded-lg border bg-muted p-4", className)}
      >
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {preparing
              ? "Preparing the interview — compiling context and indexing knowledge…"
              : "Transcript appears here once you start talking."}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {entries.map((entry, i) => (
            <div key={i} className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={cn(
                  "max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm",
                  entry.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "border bg-background",
                )}
              >
                <div className={cn(
                  "mb-0.5 text-[11px] font-medium",
                  entry.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground",
                )}>
                  {entry.role === "user" ? "You" : "Trainer"}
                </div>
                {entry.text}
              </div>
            </div>
          ))}
          {preparing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> Preparing…
            </div>
          )}
        </div>
      </section>
    );
  }

  const coverageCard = (
    <Card className="min-h-0 flex-1 overflow-y-auto">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Evidence coverage</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap content-start gap-1.5">
        {Object.keys(coverage).length === 0 && (
          <p className="text-xs text-muted-foreground">Appears after the first answer.</p>
        )}
        {Object.entries(coverage).map(([key, status]) => (
          <Badge
            key={key}
            variant="outline"
            className={cn(
              status === "sufficient" && "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
              status === "partial" && "border-amber-500/50 text-amber-600 dark:text-amber-400",
              status === "unresolved" && "border-red-500/50 text-red-600 dark:text-red-400",
              !["sufficient", "partial", "unresolved"].includes(status) && "text-muted-foreground",
            )}
          >
            {key}: {status}
          </Badge>
        ))}
      </CardContent>
    </Card>
  );

  return (
    <div className="grid h-dvh w-dvw grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background">
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      {/* header */}
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Link
            href="/"
            aria-label="Back to TrainerTwin Studio"
            className="mr-1 grid size-9 shrink-0 place-items-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Image src="/trainertwin-mark.svg" alt="" width={23} height={17} priority />
          </Link>
          <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
          {connected ? (
            <>
              <time>{mm}:{ss}</time>
              <span aria-hidden="true" className="text-border">|</span>
              <span className="truncate max-w-48">
                {persona} × {agent}
              </span>
              {phaseName && (
                <>
                  <span aria-hidden="true" className="text-border">|</span>
                  <span className="truncate">{phaseName}</span>
                </>
              )}
            </>
          ) : (
            <span>New session</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {connected && (
            <>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open code editor"
                  onClick={() => setSurface({ key: `manual-code-${Date.now()}`, tool: "code", language: "javascript", starterCode: "" })}
                >
                  <Code2 />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open whiteboard"
                  onClick={() => setSurface({ key: `manual-canvas-${Date.now()}`, tool: "canvas" })}
                >
                  <PenLine />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open PDF viewer"
                  onClick={() => setSurface({ key: `manual-pdf-${Date.now()}`, tool: "pdf" })}
                >
                  <FileText />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open presentation"
                  onClick={() => setSurface({ key: `manual-presentation-${Date.now()}`, tool: "presentation" })}
                >
                  <Presentation />
                </Button>
                {surface && (
                  <Button variant="ghost" size="icon-sm" aria-label="Close workspace" onClick={() => setSurface(null)}>
                    <X />
                  </Button>
                )}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
              </div>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "inline-block size-2 rounded-full",
                    state_ === "ready" ? "bg-emerald-500" : "animate-pulse bg-amber-500",
                  )}
                />
                {preparing ? "preparing" : "live"}
              </span>
            </>
          )}
          <ThemeToggle />
          {connected && (
            <Button variant="destructive" size="sm" onClick={disconnect}>
              <PhoneOff data-icon="inline-start" /> End
            </Button>
          )}
        </div>
      </header>

      {/* main */}
      <main className="min-h-0 overflow-hidden p-3">
        {!connected ? (
          <div className="mx-auto flex h-full max-w-xl items-center">
            <Card className="w-full">
              <CardHeader>
                <CardTitle>Configure the interview</CardTitle>
                <CardDescription>
                  Pick a persona and agent. The agent server must be running ({AGENT_URL}).
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
                  <span className="font-medium">Agent</span>
                  <Select value={agent} onValueChange={(v) => v !== null && setAgent(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Agent" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Agents</SelectLabel>
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
                    <Select value={contextId} onValueChange={(v) => v !== null && setContextId(v)}>
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
                        const form = new FormData();
                        form.append("file", file);
                        const res = await fetch("/api/upload", { method: "POST", body: form });
                        const data = await res.json().catch(() => null);
                        setUploadingContext(false);
                        if (!res.ok) {
                          setError(data?.error ?? "Upload failed");
                          return;
                        }
                        setContextList((prev) => [
                          ...prev,
                          { id: data.id, name: data.name, size: file.size },
                        ]);
                        setContextId(data.id);
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
                  onClick={connect}
                  disabled={!persona || !agent}
                  className="w-full"
                >
                  <Play data-icon="inline-start" /> Start session
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : rtviClient ? (
          <PipecatWorkspaceProvider client={rtviClient} onSurface={setSurface}>
            <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
              {surface ? (
                <section aria-label="Session workspace" className="min-h-0 overflow-hidden rounded-lg border">
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
                </section>
              ) : (
                renderTranscript("h-full")
              )}

              <aside className="hidden min-h-0 flex-col gap-3 lg:flex">
                {surface && renderTranscript("min-h-0 flex-1")}
                {coverageCard}
              </aside>
            </div>
          </PipecatWorkspaceProvider>
        ) : null}
      </main>

      {/* footer controls */}
      <footer className="relative flex items-center justify-center border-t px-4 py-3">
        {connected ? (
          <div className="flex items-center gap-2">
            {audioBlocked && (
              <Button variant="outline" onClick={playRemoteAudio}>
                Enable audio
              </Button>
            )}
            <Button
              variant={micOn ? "secondary" : "destructive"}
              size="icon"
              onClick={toggleMic}
              aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
            >
              {micOn ? <Mic /> : <MicOff />}
            </Button>
            <Button variant="destructive" onClick={disconnect}>
              <PhoneOff data-icon="inline-start" /> End session
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Configure and start a session above.</p>
        )}
      </footer>
    </div>
  );
}
