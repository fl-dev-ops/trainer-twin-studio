"use client";

import { useEffect, useState } from "react";
import { CloudDownload, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { chooseDriveFiles } from "@/lib/google-drive-picker";

type SelectedFile = { id: string; name: string; status: "pending" | "importing" | "done" | "failed" | "existing"; error?: string };
const message = (error: unknown) => error instanceof Error ? error.message : "Google Drive import failed. Try again.";

export function GoogleDriveImport({ onSuccess, onPickerOpenChange }: { onSuccess: () => void; onPickerOpenChange: (open: boolean) => void }) {
  const [connection, setConnection] = useState<"checking" | "connected" | "disconnected" | "unconfigured">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<SelectedFile[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/connectors/google-drive/session", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        setConnection(response.ok ? "connected" : response.status === 503 ? "unconfigured" : "disconnected");
        if (!response.ok && response.status !== 401) setError(data.error ?? "Google Drive is unavailable.");
      })
      .catch((error) => { if (!cancelled) { setConnection("disconnected"); setError(message(error)); } });
    return () => { cancelled = true; };
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/connectors/google-drive/oauth/start", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not connect Google Drive.");
      window.location.assign(data.url);
    } catch (error) { setError(message(error)); setBusy(false); }
  }

  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/connectors/google-drive/session", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        setConnection(response.status === 503 ? "unconfigured" : "disconnected");
        throw new Error(data.error ?? "Reconnect Google Drive.");
      }
      const picked = await chooseDriveFiles(data, () => onPickerOpenChange(true));
      if (picked.length > 50) throw new Error("Choose up to 50 files at a time.");
      if (picked.length) setFiles([...new Map(picked.map((file) => [file.id, { ...file, status: "pending" as const }])).values()]);
    } catch (error) { setError(message(error)); }
    finally { onPickerOpenChange(false); setBusy(false); }
  }

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/connectors/google-drive/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not clear Google Drive access. Try again.");
      setConnection("disconnected");
      setFiles([]);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function importFiles() {
    setBusy(true);
    setError(null);
    let succeeded = false;
    for (const file of files.filter((file) => ["pending", "failed"].includes(file.status))) {
      const update = (status: SelectedFile["status"], error?: string) => setFiles((current) => current.map((item) => item.id === file.id ? { ...item, status, error } : item));
      update("importing");
      try {
        const response = await fetch("/api/connectors/google-drive/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId: file.id }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not import this file.");
        update(data.alreadyImported ? "existing" : "done");
        succeeded = true;
      } catch (error) { update("failed", message(error)); }
    }
    if (succeeded) onSuccess();
    setBusy(false);
  }

  const ready = files.filter((file) => ["pending", "failed"].includes(file.status)).length;
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="font-medium">Import from Google Drive</h3>
        <p className="text-sm text-muted-foreground">Choose documents to copy into your twin’s knowledge. Only the files you select are accessible.</p>
        <p className="text-sm text-muted-foreground">PDFs and uploaded documents keep their original format. Google Docs, Sheets and Slides are exported as Word, Excel and PowerPoint. Originals and Markdown are saved separately; no indexing runs.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {connection === "checking" ? <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Checking Google Drive…</span> : connection === "connected" ? (
          <>
            <Button disabled={busy} onClick={choose}><CloudDownload /> Choose files</Button>
            <Button variant="ghost" disabled={busy} onClick={forget}>Use another account</Button>
          </>
        ) : <Button disabled={busy || connection === "unconfigured"} onClick={connect}>{busy ? <Spinner /> : <CloudDownload />} Connect Google Drive</Button>}
      </div>
      {files.length ? (
        <>
          <ul className="divide-y rounded-xl border px-3" aria-label="Selected Google Drive files" aria-live="polite">
            {files.map((file) => (
              <li key={file.id} className="flex items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0"><p className="truncate font-medium">{file.name}</p>{file.error ? <p className="mt-1 text-destructive">{file.error}</p> : null}</div>
                <span className="shrink-0 text-muted-foreground">{file.status === "importing" ? <Spinner /> : ({ pending: "Ready", done: "Saved", failed: "Failed", existing: "Already imported" } as const)[file.status]}</span>
              </li>
            ))}
          </ul>
          <Button disabled={busy || !ready} onClick={importFiles}>{busy ? <Spinner /> : <RefreshCw />} {busy ? "Working…" : `Import ${ready} ${ready === 1 ? "file" : "files"}`}</Button>
        </>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">Up to 25 MB per file. Google Workspace exports are also subject to Google’s 10 MB export limit. Imports are snapshots, not synced folders. Deleting a copy here never deletes the Drive original.</p>
    </div>
  );
}
