"use client";

import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Layers,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

type UploadQueueItem = {
  id: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
};

const SUPPORTED_EXTS = ["pdf", "docx", "doc", "pptx", "ppsx", "csv", "txt", "md"];
const ACCEPT_STRING = ".pdf,.docx,.doc,.pptx,.ppsx,.csv,.txt,.md,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeUploadModal({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | File[]) {
    const newItems: UploadQueueItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      if (!SUPPORTED_EXTS.includes(ext)) {
        toast.error(`Unsupported format: ${file.name}`);
        continue;
      }
      newItems.push({
        id: `${file.name}-${Date.now()}-${i}`,
        file,
        status: "pending",
      });
    }
    setQueue((prev) => [...prev, ...newItems]);
  }

  function removeItem(id: string) {
    if (isUploading) return;
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }

  async function startUpload() {
    if (queue.length === 0 || isUploading) return;
    setIsUploading(true);
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status === "done") continue;

      setQueue((prev) =>
        prev.map((q, idx) => (idx === i ? { ...q, status: "uploading" } : q)),
      );

      try {
        const formData = new FormData();
        formData.append("file", item.file);

        const res = await fetch("/api/knowledge/upload", {
          method: "POST",
          body: formData,
        });

        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error || "Upload failed");
        }

        setQueue((prev) =>
          prev.map((q, idx) => (idx === i ? { ...q, status: "done" } : q)),
        );
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setQueue((prev) =>
          prev.map((q, idx) =>
            idx === i ? { ...q, status: "error", error: msg } : q,
          ),
        );
        failCount++;
      }
    }

    setIsUploading(false);

    if (successCount > 0) {
      toast.success(
        `Successfully indexed ${successCount} document${successCount > 1 ? "s" : ""}`,
      );
      onSuccess();
    }
    if (failCount === 0) {
      setTimeout(() => {
        setQueue([]);
        onOpenChange(false);
      }, 600);
    }
  }

  const allDone = queue.length > 0 && queue.every((q) => q.status === "done");
  const completedCount = queue.filter((q) => q.status === "done").length;
  const progressPercent = queue.length > 0 ? (completedCount / queue.length) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Grounding Documents</DialogTitle>
          <DialogDescription>
            Files are converted to markdown, stored in S3, chunked, and indexed into your organization vector space.
          </DialogDescription>
        </DialogHeader>

        {/* Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
          }}
          onClick={() => !isUploading && fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${
            dragOver
              ? "border-primary bg-primary/5"
              : "border-border/80 hover:border-primary/50 hover:bg-muted/30"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_STRING}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
            <Upload className="size-5" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">
            Click to browse or drag and drop files here
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Supports PDF, DOCX, PPTX, CSV, TXT, and Markdown (up to 25MB)
          </p>
        </div>

        {/* Selected files queue */}
        {queue.length > 0 && (
          <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
            {isUploading && (
              <div className="mb-1 space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Uploading & Indexing...</span>
                  <span>{Math.round(progressPercent)}%</span>
                </div>
                <Progress value={progressPercent} className="h-1.5" />
              </div>
            )}

            {queue.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-foreground">
                    {item.file.name}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    ({formatBytes(item.file.size)})
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {item.status === "uploading" && (
                    <span className="flex items-center gap-1 text-primary">
                      <Spinner className="size-3.5" />
                      <span>Indexing</span>
                    </span>
                  )}
                  {item.status === "done" && (
                    <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5" />
                      <span>Done</span>
                    </span>
                  )}
                  {item.status === "error" && (
                    <span className="flex items-center gap-1 text-destructive" title={item.error}>
                      <AlertCircle className="size-3.5" />
                      <span>Error</span>
                    </span>
                  )}
                  {item.status === "pending" && !isUploading && (
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="mt-2 gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => {
              setQueue([]);
              onOpenChange(false);
            }}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            onClick={startUpload}
            disabled={queue.length === 0 || isUploading || allDone}
          >
            {isUploading ? (
              <>
                <Spinner data-icon="inline-start" />
                <span>Processing files...</span>
              </>
            ) : (
              <>
                <Upload data-icon="inline-start" />
                <span>Upload and Index ({queue.length})</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
