"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PDFViewer, type PDFViewerHandle } from "@/components/extend/pdf-viewer";
import { useWorkspaceHandlers } from "@/lib/livekit-workspaces";

export function PdfViewerSurface({
  sourceUrl,
  initialPage,
  highlightQuery,
  exactHighlight,
  resumeDocument,
  searchRequestId,
  onHighlightResult,
  title,
}: {
  sourceUrl?: string;
  initialPage?: number;
  highlightQuery?: string;
  exactHighlight?: boolean;
  resumeDocument?: boolean;
  searchRequestId?: string;
  onHighlightResult?: (requestId: string, status: "highlighted" | "not_found" | "viewer_unavailable" | "document_mismatch") => void;
  title?: string;
}) {
  const register = useWorkspaceHandlers();
  const fileInput = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<PDFViewerHandle>(null);
  const [localFile, setLocalFile] = useState<{ url: string; name: string; originalSource?: string }>();
  const [loadedSource, setLoadedSource] = useState<string | undefined>();
  const local = localFile?.originalSource === sourceUrl ? localFile : undefined;
  const source = local?.url ?? sourceUrl;
  const fileName = local?.name ?? title ?? (sourceUrl ? decodeURIComponent(sourceUrl.split("/").pop()?.split("?")[0] || "Document.pdf") : "Document.pdf");
  useEffect(() => () => { if (localFile) URL.revokeObjectURL(localFile.url); }, [localFile]);

  useEffect(() => register("workspace.preview", async (raw) => {
    const request = JSON.parse(raw) as { action?: string; payload?: { query?: unknown } };
    if (request.action === "get_state") return JSON.stringify({ ok: true, result: { ready: true } });
    const query = request.payload?.query;
    if (request.action !== "highlight" || typeof query !== "string" || !query.trim()) throw new Error("Invalid PDF highlight request");
    for (const delay of [0, 100, 300, 600]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const status = await viewerRef.current?.searchExact?.(query) ?? "viewer_unavailable";
      if (status === "highlighted") return JSON.stringify({ ok: true, result: { status } });
      if (status === "not_found") throw new Error("Text was not found in the PDF");
    }
    throw new Error("PDF viewer is not ready to highlight text");
  }, () => Boolean(source && loadedSource === source)), [loadedSource, register, source]);

  useEffect(() => {
    if (!highlightQuery || exactHighlight) return;
    const runSearch = () => {
      if (viewerRef.current?.search) {
        viewerRef.current.search(highlightQuery);
      }
    };
    runSearch();
    const t1 = setTimeout(runSearch, 300);
    const t2 = setTimeout(runSearch, 800);
    const t3 = setTimeout(runSearch, 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [highlightQuery, source, exactHighlight]);

  useEffect(() => {
    if (!exactHighlight || !highlightQuery || !searchRequestId || !source || loadedSource !== source) return;
    if (resumeDocument && source !== sourceUrl) {
      onHighlightResult?.(searchRequestId, "document_mismatch");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (const delay of [0, 300, 800]) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (cancelled) return;
          const status = await viewerRef.current?.searchExact?.(highlightQuery) ?? "viewer_unavailable";
          if (status !== "viewer_unavailable") {
            if (!cancelled) onHighlightResult?.(searchRequestId, status);
            return;
          }
        }
        if (!cancelled) onHighlightResult?.(searchRequestId, "viewer_unavailable");
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [exactHighlight, highlightQuery, loadedSource, onHighlightResult, resumeDocument, searchRequestId, source, sourceUrl]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setLocalFile({ url: URL.createObjectURL(file), name: file.name, originalSource: sourceUrl });
        }}
      />
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
        <span className="truncate text-sm font-medium">{fileName}</span>
        {!resumeDocument && <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => fileInput.current?.click()}
        >
          <FileUp data-icon="inline-start" />
          {source ? "Replace" : "Open"}
        </Button>}
      </header>
      <div className="relative min-h-0 flex-1">
        {source ? (
          <PDFViewer
            ref={viewerRef}
            src={source}
            fileName={fileName}
            className="h-full"
            showUpload={false}
            initialSearchQuery={exactHighlight ? undefined : highlightQuery}
            onDocumentLoadSuccess={() => {
              setLoadedSource(source);
              if (initialPage && initialPage > 1) {
                setTimeout(() => viewerRef.current?.scrollToPage(initialPage), 150);
              }
              if (highlightQuery && !exactHighlight) {
                setTimeout(() => viewerRef.current?.search?.(highlightQuery), 250);
              }
            }}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-4 text-center">
              <div className="grid size-16 place-items-center rounded-2xl border bg-card shadow-sm">
                <FileUp className="size-7" />
              </div>
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold tracking-tight">Open a PDF</h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  Choose a document to read together. It stays in your browser.
                </p>
              </div>
              {!resumeDocument && <Button size="lg" onClick={() => fileInput.current?.click()}>
                Choose PDF
              </Button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
