"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  MessageSquare,
  Music,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Source = {
  id: string;
  kind: string;
  name: string;
  status: string;
  metadata?: unknown;
  createdAt: Date;
};

type PersonaSourcePanelProps = {
  personaSlug: string;
  initialSources: Source[];
  disabled?: boolean;
};

const STATUS: Record<string, { label: string; variant: "secondary" | "warning" | "success" | "destructive" }> = {
  uploaded: { label: "Queued", variant: "secondary" },
  analyzing: { label: "Analyzing", variant: "warning" },
  compiling: { label: "Updating persona", variant: "warning" },
  analyzed: { label: "Ready", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
};

function voiceMomentCount(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const value = (metadata as Record<string, unknown>).voiceMoments;
  return typeof value === "number" ? value : 0;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "size-4 text-muted-foreground";
  if (kind === "video") return <Video className={cls} />;
  if (kind === "audio") return <Music className={cls} />;
  if (kind === "document") return <FileText className={cls} />;
  return <MessageSquare className={cls} />;
}

export function PersonaSourcePanel({
  personaSlug,
  initialSources,
  disabled,
}: PersonaSourcePanelProps) {
  const [sources, setSources] = useState<Source[]>(initialSources);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch(`/api/personas/${personaSlug}/sources`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.sources) return;
      setSources(
        data.sources.map((s: Omit<Source, "createdAt"> & { createdAt: string }) => ({
          ...s,
          createdAt: new Date(s.createdAt),
        })),
      );
    } catch {
      /* polling retries */
    }
  }, [personaSlug]);

  useEffect(() => {
    if (!sources.some((s) => s.status === "analyzing" || s.status === "compiling")) return;
    const id = setInterval(fetchSources, 3000);
    return () => clearInterval(id);
  }, [sources, fetchSources]);

  async function analyze(id: string) {
    const res = await fetch(`/api/personas/${personaSlug}/sources/${id}/analyze`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? "Analyze failed");
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length || disabled) return;
    setUploading(true);
    const uploaded: string[] = [];
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch(`/api/personas/${personaSlug}/sources`, { method: "POST", body: form });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          toast.error(`${file.name}: ${data?.error ?? "Upload failed"}`);
          continue;
        }
        if (typeof data?.id === "string") uploaded.push(data.id);
      } catch {
        toast.error(`${file.name}: Upload failed`);
      }
    }
    setUploading(false);
    await fetchSources();
    for (const id of uploaded) {
      try {
        await analyze(id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Analyze failed");
      }
    }
    if (uploaded.length) toast.success(`Analyzing ${uploaded.length} source${uploaded.length === 1 ? "" : "s"}`);
    await fetchSources();
  }

  async function retry(id: string) {
    try {
      await analyze(id);
      toast.success("Analysis started");
      await fetchSources();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Analyze failed");
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this source?")) return;
    try {
      const res = await fetch(`/api/personas/${personaSlug}/sources/${id}`, { method: "DELETE" });
      if (!res.ok) toast.error("Could not remove source");
      await fetchSources();
    } catch {
      toast.error("Could not remove source");
    }
  }

  const ready = sources.filter((s) => s.status === "analyzed" && voiceMomentCount(s.metadata) > 0).length;

  return (
    <section className="order-1 flex min-h-[32rem] min-w-0 flex-col p-4 sm:p-6 lg:min-h-0 lg:overflow-hidden">
      <div className="shrink-0">
        <h2 className="text-sm font-semibold">Source library</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Add videos, chats, or notes. Real conversation moments become available to live sessions automatically.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(e) => {
          handleUpload(e.target.files);
          e.target.value = "";
        }}
      />

      <button
        type="button"
        disabled={disabled || uploading}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleUpload(e.dataTransfer.files);
        }}
        className={cn(
          "mt-5 rounded-xl border border-dashed px-3 py-6 text-center transition-colors",
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:border-foreground/30 hover:bg-muted/40",
          dragging && "border-primary bg-primary/5",
        )}
      >
        {uploading ? (
          <Spinner className="mx-auto size-5 text-muted-foreground" />
        ) : (
          <Upload className="mx-auto size-5 text-muted-foreground" />
        )}
        <p className="mt-2 text-sm font-medium">{uploading ? "Uploading…" : "Drop files or click"}</p>
        <p className="mt-1 text-xs text-muted-foreground">Video, audio, transcript, chat export, document</p>
      </button>

      <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {sources.map((s) => {
          const moments = voiceMomentCount(s.metadata);
          const needsIndex = s.status === "analyzed" && moments === 0;
          const status = needsIndex ? { label: "Needs indexing", variant: "warning" as const } : STATUS[s.status] ?? STATUS.uploaded;
          return (
            <div key={s.id} className="flex items-start gap-2 rounded-lg border bg-background px-3 py-2">
              <KindIcon kind={s.kind} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{s.name}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant={status.variant}>
                    {(s.status === "analyzing" || s.status === "compiling") && <Spinner className="size-3" />}
                    {status.label}
                  </Badge>
                  {moments > 0 && <span className="text-[11px] text-muted-foreground">{moments} moments</span>}
                </div>
              </div>
              {!disabled && (
                <div className="flex shrink-0 items-center">
                  {(s.status === "uploaded" || s.status === "failed" || needsIndex) && (
                    <Button variant="ghost" size="sm" onClick={() => retry(s.id)}>
                      {needsIndex ? "Index" : s.status === "failed" ? "Retry" : "Analyze"}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => remove(s.id)} aria-label={`Remove ${s.name}`}>
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 border-t pt-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className={cn("size-2 rounded-full", ready ? "bg-emerald-500" : "bg-muted-foreground/30")} />
          {ready} source{ready === 1 ? "" : "s"} shaping this persona
        </div>
        <p className="mt-1 pl-4 text-xs leading-5 text-muted-foreground">
          New analyzed material is searched automatically during future conversations.
        </p>
      </div>
    </section>
  );
}
