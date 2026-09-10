"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ExternalLink,
  FileCode,
  FileSpreadsheet,
  FileText,
  Layers,
  RefreshCw,
  Trash2,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { PDFViewer } from "@/components/extend/pdf-viewer";
import { DocxViewerPreview } from "@/components/extend/docx-viewer";
import { PptxViewerPreview } from "@/components/extend/pptx-viewer";
import { CsvViewer } from "@/components/extend/csv-viewer";
import { PreviewWrapper } from "./preview-wrapper";
import type { KnowledgeDoc } from "./types";

function getFileIcon(ext: string, connector?: string) {
  if (connector === "youtube") {
    return <Video className="size-4 text-white/80 shrink-0" />;
  }
  if (connector === "notion" || connector === "notion_public") {
    return <BookOpen className="size-4 text-white/80 shrink-0" />;
  }
  switch (ext.toLowerCase()) {
    case "pdf":
      return <FileText className="size-4 text-white/80 shrink-0" />;
    case "docx":
    case "doc":
      return <FileText className="size-4 text-white/80 shrink-0" />;
    case "pptx":
    case "ppsx":
      return <Layers className="size-4 text-white/80 shrink-0" />;
    case "csv":
      return <FileSpreadsheet className="size-4 text-white/80 shrink-0" />;
    default:
      return <FileCode className="size-4 text-white/80 shrink-0" />;
  }
}

export function DocumentDetailDrawer({
  doc,
  open,
  onOpenChange,
  onRefreshSource,
  onDeleteDoc,
  refreshingSource = false,
}: {
  doc: KnowledgeDoc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReindexDoc?: (doc: KnowledgeDoc) => Promise<void>;
  onRefreshSource?: (doc: KnowledgeDoc) => Promise<void>;
  onDeleteDoc: (doc: KnowledgeDoc) => Promise<void>;
  reindexing?: boolean;
  refreshingSource?: boolean;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!doc || !open) {
      setPreviewUrl(null);
      return;
    }

    if (doc.connector === "youtube") {
      setPreviewUrl(doc.sourceUrl || null);
      setLoadingPreview(false);
      return;
    }

    let cancelled = false;
    setLoadingPreview(true);

    fetch(`/api/knowledge/documents/${doc.id}/preview`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setPreviewUrl(data.url || null);
          setLoadingPreview(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl(null);
          setLoadingPreview(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [doc, open]);

  if (!doc) return null;

  const isConnectorDoc =
    doc.connector === "notion" ||
    doc.connector === "notion_public" ||
    doc.connector === "youtube";

  const youtubeVideoId =
    doc.connector === "youtube"
      ? doc.externalId ||
        doc.sourceUrl?.match(/(?:v=|\/embed\/|\.be\/)([^?&]+)/)?.[1] ||
        doc.slug.replace(/^youtube_|\.json$/g, "")
      : null;

  async function handleDelete() {
    if (!doc) return;
    setDeleting(true);
    try {
      await onDeleteDoc(doc);
      setConfirmDeleteOpen(false);
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  }

  const actions = (
    <>
      {doc.sourceUrl && (
        <a
          href={doc.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-white/10 hover:bg-white/20 text-xs text-white font-medium transition-colors backdrop-blur-sm"
        >
          <ExternalLink className="size-3.5" />
          <span>Open link</span>
        </a>
      )}

      {isConnectorDoc && onRefreshSource && (
        <button
          type="button"
          onClick={() => onRefreshSource(doc)}
          disabled={refreshingSource}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-white/10 hover:bg-white/20 text-xs text-white font-medium transition-colors disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`size-3.5 ${refreshingSource ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => setConfirmDeleteOpen(true)}
        className="size-8 rounded-full flex items-center justify-center text-white/70 hover:text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
        aria-label="Delete document"
        title="Delete document"
      >
        <Trash2 className="size-4" />
      </button>
    </>
  );

  return (
    <>
      <PreviewWrapper
        open={open}
        onOpenChange={onOpenChange}
        title={doc.title || doc.slug}
        icon={getFileIcon(doc.ext, doc.connector)}
        actions={actions}
      >
        {doc.connector === "youtube" && youtubeVideoId ? (
          <div className="w-full aspect-video rounded-2xl overflow-hidden shadow-2xl bg-black">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${youtubeVideoId}?autoplay=1`}
              title={doc.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="w-full h-full border-0"
            />
          </div>
        ) : loadingPreview ? (
          <div className="flex flex-col items-center gap-3">
            <Spinner className="size-8 text-white/80" />
            <p className="text-xs text-white/60">Loading document...</p>
          </div>
        ) : !previewUrl ? (
          <div className="text-center p-8 max-w-md bg-white/5 rounded-2xl backdrop-blur-md border border-white/10 text-white">
            <p className="text-sm font-medium">Preview not available</p>
            <p className="text-xs text-white/60 mt-1">
              Could not load a direct preview for this document.
            </p>
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center overflow-hidden">
            {doc.ext === "pdf" && (
              <div className="h-full w-full rounded-2xl overflow-hidden shadow-2xl bg-background">
                <PDFViewer src={previewUrl} fileName={doc.slug} className="h-full" />
              </div>
            )}
            {doc.ext === "docx" && (
              <div className="h-full w-full rounded-2xl overflow-hidden shadow-2xl bg-background">
                <DocxViewerPreview
                  src={previewUrl}
                  fileName={doc.slug}
                  className="h-full"
                  isDark={false}
                  onIsDarkChange={() => {}}
                />
              </div>
            )}
            {(doc.ext === "pptx" || doc.ext === "ppsx") && (
              <div className="h-full w-full rounded-2xl overflow-hidden shadow-2xl bg-background">
                <PptxViewerPreview src={previewUrl} fileName={doc.slug} className="h-full" />
              </div>
            )}
            {doc.ext === "csv" && (
              <div className="h-full w-full rounded-2xl overflow-hidden shadow-2xl bg-background">
                <CsvPreviewLoader url={previewUrl} />
              </div>
            )}
            {!["pdf", "docx", "pptx", "ppsx", "csv"].includes(doc.ext) && (
              <div className="h-full w-full rounded-2xl bg-card/95 text-foreground shadow-2xl border border-white/10 overflow-hidden flex flex-col backdrop-blur-xs">
                <TextPreviewLoader url={previewUrl} />
              </div>
            )}
          </div>
        )}
      </PreviewWrapper>

      {/* Confirmation Dialog for Delete */}
      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <div className="flex items-center gap-2.5 text-destructive font-semibold text-base">
            <AlertCircle className="size-5" />
            <span>Delete &quot;{doc.title || doc.slug}&quot;?</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            This will permanently remove the document from storage and delete all associated vector embeddings.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Confirm Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CsvPreviewLoader({ url }: { url: string }) {
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setData)
      .catch(() => setError(true));
  }, [url]);

  if (error) return <p className="p-4 text-xs text-destructive">Could not load CSV file.</p>;
  if (data === null) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-primary" />
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <CsvViewer data={data} />
    </ScrollArea>
  );
}

function TextPreviewLoader({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setText)
      .catch(() => setError(true));
  }, [url]);

  if (error) return <p className="p-4 text-xs text-destructive">Could not load text file.</p>;
  if (text === null) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-primary" />
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap p-8 font-mono text-xs text-foreground/90 leading-relaxed max-w-3xl mx-auto">{text}</pre>
    </ScrollArea>
  );
}
