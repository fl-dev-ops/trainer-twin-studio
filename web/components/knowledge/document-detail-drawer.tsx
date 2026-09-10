"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileCode,
  FileSpreadsheet,
  FileText,
  Info,
  Layers,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PDFViewer } from "@/components/extend/pdf-viewer";
import { DocxViewerPreview } from "@/components/extend/docx-viewer";
import { PptxViewerPreview } from "@/components/extend/pptx-viewer";
import { CsvViewer } from "@/components/extend/csv-viewer";
import type { KnowledgeDoc } from "./types";

type ChunkItem = {
  id: string;
  chunkIndex: number;
  text: string;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const dateStr = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dateStr} ${hours}:${minutes} UTC`;
}

function getFileIcon(ext: string, connector?: string) {
  if (connector === "youtube") {
    return <Video className="size-5 text-red-500" />;
  }
  if (connector === "notion" || connector === "notion_public") {
    return <BookOpen className="size-5 text-stone-600 dark:text-stone-300" />;
  }
  switch (ext.toLowerCase()) {
    case "pdf":
      return <FileText className="size-5 text-red-500" />;
    case "docx":
    case "doc":
      return <FileText className="size-5 text-blue-500" />;
    case "pptx":
    case "ppsx":
      return <Layers className="size-5 text-amber-500" />;
    case "csv":
      return <FileSpreadsheet className="size-5 text-emerald-500" />;
    default:
      return <FileCode className="size-5 text-muted-foreground" />;
  }
}

export function DocumentDetailDrawer({
  doc,
  open,
  onOpenChange,
  onReindexDoc,
  onRefreshSource,
  onDeleteDoc,
  reindexing = false,
  refreshingSource = false,
}: {
  doc: KnowledgeDoc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReindexDoc: (doc: KnowledgeDoc) => Promise<void>;
  onRefreshSource?: (doc: KnowledgeDoc) => Promise<void>;
  onDeleteDoc: (doc: KnowledgeDoc) => Promise<void>;
  reindexing?: boolean;
  refreshingSource?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<string>("chunks");
  const [chunks, setChunks] = useState<ChunkItem[] | null>(null);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [chunkSearch, setChunkSearch] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Load chunks when doc changes or tab switches to chunks
  useEffect(() => {
    if (!doc || !open) return;

    let cancelled = false;
    setLoadingChunks(true);

    fetch(`/api/knowledge/documents/${doc.id}/chunks`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setChunks(data.chunks || []);
          setLoadingChunks(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChunks([]);
          setLoadingChunks(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [doc, open]);

  // Load preview URL when preview tab selected or doc opened
  useEffect(() => {
    if (!doc || !open) {
      setPreviewUrl(null);
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

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Chunk text copied to clipboard");
  }

  if (!doc) return null;

  const filteredChunks = (chunks || []).filter(
    (c) =>
      !chunkSearch ||
      c.text.toLowerCase().includes(chunkSearch.toLowerCase()) ||
      `chunk ${c.chunkIndex + 1}`.includes(chunkSearch.toLowerCase()),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl md:max-w-3xl lg:max-w-4xl p-0 gap-0 border-l shadow-2xl flex flex-col h-full bg-background"
        showCloseButton={false}
      >
        {/* Top Header */}
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-3 min-w-0 pr-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted border">
              {getFileIcon(doc.ext, doc.connector)}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SheetTitle className="truncate text-base font-semibold">
                  {doc.title || doc.slug}
                </SheetTitle>
                <Badge
                  variant={
                    doc.status === "indexed"
                      ? "outline"
                      : doc.status === "digesting" || doc.status === "syncing"
                      ? "outline"
                      : "secondary"
                  }
                  className={`text-[10px] uppercase font-bold shrink-0 ${
                    doc.status === "indexed"
                      ? "border-emerald-500/30 text-emerald-600 bg-emerald-500/10"
                      : doc.status === "digesting" || doc.status === "syncing"
                      ? "border-amber-500/30 text-amber-600 bg-amber-500/10"
                      : ""
                  }`}
                >
                  {doc.status}
                </Badge>
              </div>
              <p className="truncate text-xs font-mono text-muted-foreground mt-0.5">
                {doc.slug} • {formatBytes(doc.size)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {doc.connector === "notion" ||
            doc.connector === "notion_public" ||
            doc.connector === "youtube" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRefreshSource && onRefreshSource(doc)}
                disabled={refreshingSource}
                className="h-8 gap-1.5 text-xs"
              >
                <RefreshCw className={`size-3.5 ${refreshingSource ? "animate-spin text-primary" : ""}`} />
                <span>Refresh source</span>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReindexDoc(doc)}
                disabled={reindexing}
                className="h-8 gap-1.5 text-xs"
              >
                <RefreshCw className={`size-3.5 ${reindexing ? "animate-spin text-primary" : ""}`} />
                <span>Re-index</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (confirm(`Delete ${doc.slug}?`)) {
                  await onDeleteDoc(doc);
                  onOpenChange(false);
                }
              }}
              className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              className="size-8 ml-1"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Tabs navigation */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="border-b px-5 pt-2">
            <TabsList variant="line" className="h-9">
              <TabsTrigger value="chunks" className="gap-1.5 text-xs cursor-pointer">
                <Database className="size-3.5" />
                <span>Chunks ({chunks?.length ?? "..."})</span>
              </TabsTrigger>
              <TabsTrigger value="preview" className="gap-1.5 text-xs cursor-pointer">
                <Eye className="size-3.5" />
                <span>Original File Preview</span>
              </TabsTrigger>
              <TabsTrigger value="metadata" className="gap-1.5 text-xs cursor-pointer">
                <Info className="size-3.5" />
                <span>Metadata</span>
              </TabsTrigger>
            </TabsList>
          </div>

          {/* CHUNKS TAB */}
          <TabsContent value="chunks" className="flex min-h-0 flex-1 flex-col p-0">
            <div className="flex items-center justify-between border-b px-5 py-2.5 bg-muted/20">
              <div className="relative w-72">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={chunkSearch}
                  onChange={(e) => setChunkSearch(e.target.value)}
                  placeholder="Filter chunks..."
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <span className="text-xs text-muted-foreground">
                Showing {filteredChunks.length} of {chunks?.length ?? 0} chunks
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {loadingChunks ? (
                <div className="grid h-48 place-items-center">
                  <div className="flex flex-col items-center gap-2">
                    <Spinner className="size-6 text-primary" />
                    <p className="text-xs text-muted-foreground">Fetching vector chunks from Chroma...</p>
                  </div>
                </div>
              ) : filteredChunks.length === 0 ? (
                <div className="grid h-48 place-items-center text-center">
                  <p className="text-sm text-muted-foreground">
                    {chunks?.length === 0
                      ? "No chunks indexed for this document."
                      : "No chunks match your search."}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredChunks.map((chunk) => (
                    <div
                      key={chunk.id}
                      className="rounded-xl border bg-card p-4 text-xs shadow-2xs hover:border-primary/30 transition-colors"
                    >
                      <div className="flex items-center justify-between border-b pb-2 mb-3 text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="font-mono text-[10px] font-semibold">
                            Chunk #{chunk.chunkIndex + 1}
                          </Badge>
                          <span className="text-[11px]">
                            {chunk.text.length} characters • ~{Math.round(chunk.text.length / 4)} tokens
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyText(chunk.text)}
                          className="h-6 gap-1 px-2 text-[11px]"
                        >
                          <Copy className="size-3" />
                          <span>Copy</span>
                        </Button>
                      </div>

                      <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/90 whitespace-pre-wrap font-sans text-xs leading-relaxed">
                        {chunk.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* PREVIEW TAB */}
          <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col p-4 overflow-hidden">
            {loadingPreview ? (
              <div className="grid h-full place-items-center">
                <div className="flex flex-col items-center gap-2">
                  <Spinner className="size-6 text-primary" />
                  <p className="text-xs text-muted-foreground">Loading preview from S3...</p>
                </div>
              </div>
            ) : !previewUrl ? (
              <div className="grid h-full place-items-center text-center">
                <p className="text-sm text-destructive">Preview URL not available for this file.</p>
              </div>
            ) : (
              <div className="h-full w-full overflow-hidden rounded-xl border bg-card">
                {doc.ext === "pdf" && (
                  <PDFViewer src={previewUrl} fileName={doc.slug} className="h-full" />
                )}
                {doc.ext === "docx" && (
                  <DocxViewerPreview
                    src={previewUrl}
                    fileName={doc.slug}
                    className="h-full"
                    isDark={false}
                    onIsDarkChange={() => {}}
                  />
                )}
                {(doc.ext === "pptx" || doc.ext === "ppsx") && (
                  <PptxViewerPreview src={previewUrl} fileName={doc.slug} className="h-full" />
                )}
                {doc.ext === "csv" && <CsvPreviewLoader url={previewUrl} />}
                {!["pdf", "docx", "pptx", "ppsx", "csv"].includes(doc.ext) && (
                  <TextPreviewLoader url={previewUrl} />
                )}
              </div>
            )}
          </TabsContent>

          {/* METADATA TAB */}
          <TabsContent value="metadata" className="flex-1 overflow-y-auto p-5">
            <div className="space-y-4">
              <div className="rounded-xl border bg-card p-4 space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Document Identity
                </h4>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-muted-foreground block">ID</span>
                    <span className="font-mono text-foreground font-medium select-all">{doc.id}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Knowledge Base ID</span>
                    <span className="font-mono text-foreground font-medium select-all">{doc.kbId}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Slug</span>
                    <span className="font-mono text-foreground font-medium">{doc.slug}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Title</span>
                    <span className="text-foreground font-medium">{doc.title}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border bg-card p-4 space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Storage & Indexing
                </h4>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-muted-foreground block">File Size</span>
                    <span className="text-foreground font-medium">
                      {formatBytes(doc.size)} ({doc.size.toLocaleString()} bytes)
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">File Extension</span>
                    <span className="text-foreground font-medium uppercase">{doc.ext}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Created At</span>
                    <span className="text-foreground font-medium" suppressHydrationWarning>{formatDate(doc.createdAt)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Last Indexed At</span>
                    <span className="text-foreground font-medium" suppressHydrationWarning>{formatDate(doc.indexedAt)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Status</span>
                    <span className="text-foreground font-medium capitalize">{doc.status}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Connector</span>
                    <span className="text-foreground font-medium capitalize">{doc.connector || "upload"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Total Chunks</span>
                    <span className="text-foreground font-medium">{chunks?.length ?? "Calculating..."}</span>
                  </div>
                  {doc.sourceId && (
                    <div>
                      <span className="text-muted-foreground block">Source ID</span>
                      <span className="text-foreground font-mono text-[11px] truncate block">{doc.sourceId}</span>
                    </div>
                  )}
                </div>

                {doc.error && (
                  <div className="mt-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                    <span className="font-semibold block">Last Error:</span>
                    <span className="font-mono">{doc.error}</span>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
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
      <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-foreground/90">{text}</pre>
    </ScrollArea>
  );
}
