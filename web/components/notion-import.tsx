"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { NotionImportInput } from "@/lib/notion";

type NotionConnection = {
  id: string;
  workspaceName?: string | null;
  workspaceId?: string | null;
};

type NotionJob = {
  id: string;
  connectionId: string | null;
  status: string;
  itemsDiscovered: number;
  itemsProcessed: number;
  error: string | null;
};

const STATUS_VARIANT: Record<string, "secondary" | "success" | "warning" | "destructive"> = {
  queued: "secondary",
  running: "warning",
  succeeded: "success",
  failed: "destructive",
};

export function NotionImport({ kb, onCompleted }: { kb: string; onCompleted: () => void }) {
  const [connections, setConnections] = useState<NotionConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [jobs, setJobs] = useState<NotionJob[]>([]);
  const [queueing, setQueueing] = useState<"public" | "oauth" | null>(null);
  const completedJobs = useRef(new Set<string>());

  const loadNotion = useCallback(async () => {
    const response = await fetch(`/api/knowledge/${encodeURIComponent(kb)}/notion`);
    if (!response.ok) return;
    const data = (await response.json()) as { connections?: NotionConnection[]; jobs?: NotionJob[] };
    const nextConnections = data.connections ?? [];
    setConnections(nextConnections);
    setConnectionId((current) => nextConnections.some((connection) => connection.id === current)
      ? current
      : nextConnections[0]?.id ?? "");
    setJobs(data.jobs ?? []);
  }, [kb]);

  useEffect(() => {
    const handleFocus = () => void loadNotion();
    const timeout = window.setTimeout(() => void loadNotion(), 0);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadNotion]);

  const latest = jobs.find((job) => job.connectionId === connectionId);
  const latestPublic = jobs.find((job) => job.connectionId === null);
  const active = latest?.status === "queued" || latest?.status === "running";
  const publicActive = latestPublic?.status === "queued" || latestPublic?.status === "running";
  const hasActiveJob = jobs.some((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = window.setInterval(() => void loadNotion(), 2_000);
    return () => window.clearInterval(interval);
  }, [hasActiveJob, loadNotion]);

  useEffect(() => {
    for (const job of [latest, latestPublic]) {
      if (job?.status !== "succeeded" || completedJobs.current.has(job.id)) continue;
      completedJobs.current.add(job.id);
      onCompleted();
    }
  }, [latest, latestPublic, onCompleted]);

  function connectNotion() {
    window.open(`/api/notion/oauth/start?kb=${encodeURIComponent(kb)}`, "_blank", "noopener,noreferrer");
  }

  async function queueSync(mode: "public" | "oauth") {
    const url = window.prompt(mode === "public" ? "Public Notion root page URL:" : "Notion root page URL:");
    if (!url?.trim()) return;
    setQueueing(mode);
    try {
      const input: NotionImportInput = mode === "public"
        ? { mode, url: url.trim() }
        : { mode, url: url.trim(), connectionId };
      const response = await fetch(`/api/knowledge/${encodeURIComponent(kb)}/notion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Could not queue Notion sync");
      toast.success(data?.job?.status === "running" ? "Notion sync already running" : "Notion sync queued");
      await loadNotion();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue Notion sync");
    } finally {
      setQueueing(null);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {latestPublic && (
        <Badge variant={STATUS_VARIANT[latestPublic.status] ?? "secondary"} title={latestPublic.error ?? undefined}>
          Public Notion {latestPublic.status}
          {latestPublic.itemsDiscovered > 0 && ` ${latestPublic.itemsProcessed}/${latestPublic.itemsDiscovered}`}
        </Badge>
      )}
      <Button variant="outline" size="sm" onClick={() => void queueSync("public")} disabled={queueing !== null || publicActive}>
        {queueing === "public" || publicActive ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
        {publicActive ? "Importing public Notion" : "Import public Notion"}
      </Button>
      <Button variant="outline" size="sm" onClick={connectNotion} disabled={queueing !== null || active}>
        {connections.length === 0 ? "Connect Notion" : "Connect workspace"}
      </Button>
      {connections.length > 1 && (
        <select
          aria-label="Notion workspace"
          className="h-8 max-w-40 rounded-md border bg-background px-2 text-xs text-foreground"
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
          disabled={queueing !== null || active}
        >
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.workspaceName || connection.workspaceId || "Notion workspace"}
            </option>
          ))}
        </select>
      )}
      {latest && (
        <Badge variant={STATUS_VARIANT[latest.status] ?? "secondary"} title={latest.error ?? undefined}>
          Notion {latest.status}
          {latest.itemsDiscovered > 0 && ` ${latest.itemsProcessed}/${latest.itemsDiscovered}`}
        </Badge>
      )}
      {connections.length > 0 && (
        <Button variant="outline" size="sm" onClick={() => void queueSync("oauth")} disabled={queueing !== null || active || !connectionId}>
          {queueing === "oauth" || active ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          {active ? "Syncing Notion" : "Import Notion"}
        </Button>
      )}
    </span>
  );
}
