"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlaySquare } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseYouTubeVideoId, youtubePreviewSchema, youtubeStateSchema, type YouTubePreview, type YouTubeState } from "@/lib/youtube";

const STAGES: Record<string, string> = {
  queued: "Queued", fetching_captions: "Fetching captions", processing_segments: "Processing transcript segments",
  publishing: "Publishing", ready: "Ready",
};

export function YouTubeImport({ kb, onCompleted }: { kb: string; onCompleted: () => void }) {
  const [state, setState] = useState<YouTubeState>({ configured: false, connections: [], jobs: [] });
  const [loaded, setLoaded] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<YouTubePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completedJobs = useRef(new Set<string>());
  const endpoint = `/api/knowledge/${encodeURIComponent(kb)}/youtube`;
  const connection = state.connections.find((item) => item.id === connectionId);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error("Could not load YouTube connections");
      const next = youtubeStateSchema.parse(await response.json());
      setState(next);
      setConnectionId((current) => next.connections.some((item) => item.id === current) ? current : next.connections[0]?.id ?? "");
      setLoaded(true);
    } catch {
      setError("Could not load YouTube connections. Reopen this dialog to retry.");
    }
  }, [endpoint]);

  useEffect(() => {
    const refresh = () => void loadState();
    const timeout = window.setTimeout(refresh, 0);
    window.addEventListener("focus", refresh);
    const params = new URLSearchParams(window.location.search);
    const result = params.get("youtube");
    if (result) {
      if (result === "connected") toast.success("YouTube channel connected");
      else if (result === "cancelled") toast.info("YouTube connection cancelled");
      else toast.error("Could not connect YouTube. Please try again.");
      params.delete("youtube");
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`);
    }
    return () => { window.clearTimeout(timeout); window.removeEventListener("focus", refresh); };
  }, [loadState]);

  const hasWork = state.jobs.some((job) => ["queued", "running"].includes(job.status)) || state.connections.some((item) => item.status === "disconnecting");
  useEffect(() => {
    if (!hasWork) return;
    const interval = window.setInterval(() => void loadState(), 2_000);
    return () => window.clearInterval(interval);
  }, [hasWork, loadState]);

  useEffect(() => {
    for (const job of state.jobs) {
      if (job.status !== "succeeded" || completedJobs.current.has(job.id)) continue;
      completedJobs.current.add(job.id);
      onCompleted();
    }
  }, [state.jobs, onCompleted]);

  async function request(action: "preview" | "import", refresh = false) {
    setError(null);
    if (!parseYouTubeVideoId(url)) { setError("Enter an individual YouTube video URL"); return; }
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, url, connectionId, refresh }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "YouTube import failed");
      if (action === "preview") setPreview(youtubePreviewSchema.parse(result));
      else {
        toast.success(result.alreadyIndexed ? "Video already indexed" : "YouTube video queued for indexing");
        setUrl(""); setPreview(null);
        await loadState();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "YouTube import failed");
      await loadState();
    } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!connection || !window.confirm("Disconnect this YouTube channel? Its imported transcripts and vectors will be removed from all linked knowledge bases in this organization. Pending imports will stop. Google may also invalidate related grants, requiring other connections to reconnect. Your YouTube videos will not be deleted.")) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not disconnect YouTube");
      setPreview(null);
      toast.success("YouTube disconnected. Stored content removal queued.");
      await loadState();
      onCompleted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disconnect YouTube"); }
    finally { setBusy(false); }
  }

  const latest = state.jobs[0];
  return (
    <>
      <span className="flex items-center gap-2">
        {latest && <Badge variant={latest.status === "failed" ? "destructive" : latest.status === "succeeded" ? "success" : "secondary"}>
          YouTube {latest.status === "failed" ? "Failed" : STAGES[latest.stage ?? latest.status] ?? latest.status}
        </Badge>}
        <Button variant="outline" size="sm" onClick={() => { setDialogOpen(true); setError(null); void loadState(); }}>
          <PlaySquare data-icon="inline-start" /> Import YouTube
        </Button>
      </span>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import your YouTube video</DialogTitle>
            <DialogDescription>Connect your channel and paste a video URL. Only English captions from your own videos can be imported.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!loaded && !error && <Spinner />}
            {loaded && !state.configured && <p className="text-sm text-muted-foreground">YouTube OAuth setup is required before connecting a channel.</p>}
            {state.connections.length > 0 && <div className="space-y-2">
              <label htmlFor={`youtube-channel-${kb}`} className="text-sm font-medium">Connected channel</label>
              <select id={`youtube-channel-${kb}`} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={connectionId} disabled={busy} onChange={(event) => { setConnectionId(event.target.value); setPreview(null); setError(null); }}>
                {state.connections.map((item) => <option key={item.id} value={item.id}>{item.channelTitle}{item.status !== "active" ? ` (${item.status.replaceAll("_", " ")})` : ""}</option>)}
              </select>
            </div>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!state.configured || busy} onClick={() => window.location.assign(`/api/youtube/oauth/start?kb=${encodeURIComponent(kb)}`)}>
                {connection?.status === "reconnect_required" ? "Reconnect YouTube" : "Connect YouTube"}
              </Button>
              {connection && <Button variant="ghost" size="sm" disabled={busy || connection.status === "disconnecting"} onClick={() => void disconnect()}>Disconnect</Button>}
            </div>
            {connection?.status === "disconnecting" && <p className="text-sm text-muted-foreground">Imports stopped. Stored transcripts and vectors are waiting for cleanup.</p>}
            {connection?.status === "active" && <>
              <div className="space-y-2">
                <label htmlFor={`youtube-url-${kb}`} className="text-sm font-medium">Your video URL</label>
                <Input id={`youtube-url-${kb}`} placeholder="https://www.youtube.com/watch?v=..." value={url} disabled={busy}
                  onChange={(event) => { setUrl(event.target.value); setPreview(null); setError(null); }} />
              </div>
              {preview && <div className="space-y-1 rounded-md border p-3 text-sm">
                <p className="font-medium">{preview.title}</p>
                <p className="text-muted-foreground">{preview.channelTitle} · English · {preview.isAutoGenerated ? "YouTube automatic captions" : "Creator captions"}</p>
                {preview.alreadyIndexed && <p>Already indexed. Refresh replaces its stored transcript and vectors.</p>}
              </div>}
              <p className="text-sm text-muted-foreground">Imported transcripts become available wherever this knowledge base is used, including transcripts from private videos.</p>
            </>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {state.jobs.length > 0 && <div className="max-h-36 space-y-2 overflow-y-auto text-sm" aria-live="polite">
              {state.jobs.slice(0, 5).map((job) => <div key={job.id}>
                <span>{job.videoId}: {job.status === "failed" ? "Failed" : STAGES[job.stage ?? job.status] ?? job.status}</span>
                {job.segmentsTotal > 0 && <span className="text-muted-foreground"> · {job.segmentsSucceeded}/{job.segmentsTotal} segments</span>}
                {job.error && <p className="text-destructive">{job.error}</p>}
              </div>)}
            </div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Close</Button>
            {connection?.status === "active" && <Button disabled={busy || !url.trim()} onClick={() => void request(preview ? "import" : "preview", preview?.alreadyIndexed ?? false)}>
              {busy && <Spinner data-icon="inline-start" />}{preview ? preview.alreadyIndexed ? "Refresh video" : "Import video" : "Check video"}
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
