"use client";

import { useEffect, useRef, useState } from "react";
import {
  PipecatClient,
  RTVIEvent,
  type BotOutputData,
  type TranscriptData,
  type TransportState,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

type Entry = { role: "user" | "trainer"; text: string };

type Props = {
  personas: string[];
  agents: string[];
  contexts: string[];
};

const AGENT_URL =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:7860";

export function TalkClient({ personas, agents, contexts }: Props) {
  const [persona, setPersona] = useState(personas[0] ?? "");
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [contextFile, setContextFile] = useState("");
  const [state_, setState_] = useState<TransportState>("disconnected");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const clientRef = useRef<PipecatClient | null>(null);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  async function connect() {
    setError("");
    setEntries([]);
    setCoverage({});
    const transport = new SmallWebRTCTransport({
      webrtcRequestParams: { endpoint: `${AGENT_URL}/api/offer` },
    });
    const client = new PipecatClient({
      transport,
      enableMic: true,
      callbacks: {
        onTransportStateChanged: (s) => setState_(s),
        onError: (msg) => setError((msg.data as { message?: string } | undefined)?.message ?? "Connection error"),
        onUserTranscript: (data: TranscriptData) => {
          if (!data.final) return;
          setEntries((prev) => [...prev, { role: "user", text: data.text }]);
        },
        onBotOutput: (data: BotOutputData) => {
          if (data.will_be_spoken === false) return;
          setEntries((prev) => {
            // replace the trailing in-progress trainer entry, else append
            const last = prev[prev.length - 1];
            if (last?.role === "trainer" && data.spoken_status === "in-progress") {
              return [...prev.slice(0, -1), { role: "trainer", text: data.text }];
            }
            if (last?.role === "trainer" && data.spoken_status === "completed") {
              return [...prev.slice(0, -1), { role: "trainer", text: data.text }];
            }
            return [...prev, { role: "trainer", text: data.text }];
          });
        },
        onDisconnected: () => setState_("disconnected"),
      },
    });
    clientRef.current = client;

    client.on(RTVIEvent.ServerMessage, (msg: { data?: { type?: string; state?: unknown } }) => {
      const payload = msg?.data;
      if (payload?.type === "interview-state" && typeof payload.state === "object" && payload.state !== null) {
        setCoverage((payload.state as { coverage?: Record<string, string> }).coverage ?? {});
      }
    });

    try {
      await client.connect();
      client.sendClientMessage("start-interview", {
        personaId: persona,
        agentId: agent,
        contextFile: contextFile || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
      setState_("disconnected");
    }
  }

  async function disconnect() {
    await clientRef.current?.disconnect();
    clientRef.current = null;
    setState_("disconnected");
  }

  const connected = state_ !== "disconnected" && state_ !== "error";
  const busy = connected && state_ !== "ready";

  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-[280px_1fr]">
      <aside className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Persona</label>
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            disabled={connected}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            {personas.map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Agent</label>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            disabled={connected}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            {agents.map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Context (resume)</label>
          <select
            value={contextFile}
            onChange={(e) => setContextFile(e.target.value)}
            disabled={connected}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">None</option>
            {contexts.map((c) => <option key={c}>{c}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload files under data/uploads or via the API.
          </p>
        </div>

        {!connected ? (
          <button
            onClick={connect}
            disabled={!persona || !agent}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            Start session
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="w-full rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            End session
          </button>
        )}
        {busy && <p className="text-xs text-muted-foreground">Preparing interview…</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <p className="text-xs text-muted-foreground">Agent server: {AGENT_URL}</p>
      </aside>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              state_ === "ready" ? "bg-green-500" : connected ? "animate-pulse bg-yellow-500" : "bg-gray-400"
            }`}
          />
          <span className="capitalize text-muted-foreground">{state_}</span>
        </div>

        <div className="h-[55vh] space-y-3 overflow-y-auto rounded-lg border p-4">
          {entries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Transcript appears here once you start talking.
            </p>
          )}
          {entries.map((entry, i) => (
            <div key={i} className={entry.role === "user" ? "text-right" : ""}>
              <div
                className={`inline-block max-w-[80%] rounded-lg px-3 py-2 text-left text-sm ${
                  entry.role === "user" ? "bg-primary/10" : "bg-accent"
                }`}
              >
                <div className="mb-0.5 text-xs font-semibold text-muted-foreground">
                  {entry.role === "user" ? "You" : "Trainer"}
                </div>
                {entry.text}
              </div>
            </div>
          ))}
        </div>

        {Object.keys(coverage).length > 0 && (
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Evidence coverage</h3>
            <ul className="flex flex-wrap gap-2">
              {Object.entries(coverage).map(([key, status]) => (
                <li key={key} className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(status)}`}>
                  {key}: {status}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function statusClass(status: string) {
  switch (status) {
    case "sufficient":
      return "border-green-500/50 text-green-700 dark:text-green-400";
    case "partial":
      return "border-yellow-500/50 text-yellow-700 dark:text-yellow-400";
    case "unresolved":
      return "border-red-500/50 text-red-700 dark:text-red-400";
    default:
      return "text-muted-foreground";
  }
}
