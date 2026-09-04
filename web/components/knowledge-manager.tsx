"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Eye,
  FileText,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PDFViewer } from "@/components/extend/pdf-viewer";
import { DocxViewerPreview } from "@/components/extend/docx-viewer";
import { PptxViewerPreview } from "@/components/extend/pptx-viewer";
import { CsvViewer } from "@/components/extend/csv-viewer";
import { NotionImport } from "@/components/notion-import";
import { YouTubeImport } from "@/components/youtube-import";
import {
  youtubeQuestionsArtifactSchema,
  type YouTubeQuestionsArtifact,
} from "@/lib/youtube";

type Kb = { slug: string; name: string };
type Doc = {
  id: string;
  slug: string;
  title: string;
  ext: string;
  size: number;
  status: string;
  error: string | null;
  indexedAt: string | null;
  createdAt: string;
  connector: string | null;
};

const STATUS_VARIANT: Record<string, "secondary" | "success" | "warning" | "destructive" | "outline"> = {
  uploaded: "secondary",
  digesting: "warning",
  indexed: "success",
  failed: "destructive",
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function createKb(): Promise<string | null> {
  const slug = prompt("New knowledge base id (e.g. product-management):");
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null;
  const res = await fetch(`/api/knowledge/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    toast.error(data?.error ?? "Create failed");
    return null;
  }
  return slug;
}

export function KnowledgeIndex({ bases }: { bases: Kb[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setCreating(true);
    const slug = await createKb();
    setCreating(false);
    if (slug) router.push(`/knowledge/${encodeURIComponent(slug)}`);
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Grounding documents stored in S3 and indexed into ChromaDB, one collection per base.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
              New knowledge base
            </Button>
          </div>
        </header>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {bases.map((kb) => (
            <Link
              key={kb.slug}
              href={`/knowledge/${encodeURIComponent(kb.slug)}`}
              className="group flex min-h-40 min-w-0 flex-col rounded-xl border bg-background p-5 transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                  <BookOpen className="size-4" aria-hidden="true" />
                </span>
                <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
              <span className="mt-5 block truncate text-base font-medium">{kb.name}</span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">{kb.slug}</span>
              <span className="mt-auto block pt-4 text-xs text-muted-foreground">Knowledge base</span>
            </Link>
          ))}
          {!bases.length && (
            <div className="rounded-xl border px-5 py-16 text-center md:col-span-2">
              <p className="text-sm font-medium">No knowledge bases yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Create the first base to start grounding your trainers.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export function KnowledgeDetail({ slug }: { slug: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [digestingAll, setDigestingAll] = useState(false);
  const [digestingDoc, setDigestingDoc] = useState<string | null>(null);
  const [refreshingDoc, setRefreshingDoc] = useState<{ documentId: string; jobId: string | null } | null>(null);
  const [preview, setPreview] = useState<{
    doc: Doc;
    url: string;
    type?: string;
    sourceUrl?: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [reload, setReload] = useState(0);

  const loadDocs = useCallback(async () => {
    setReload((value) => value + 1);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/knowledge/${slug}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setDocs(data.files ?? []); })
      .catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, [slug, reload]);
  const hasPendingDocs = docs?.some((d) => d.status === "digesting");
  useEffect(() => {
    if (!hasPendingDocs) return;
    const interval = window.setInterval(() => {
      void loadDocs();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [hasPendingDocs, loadDocs]);

  useEffect(() => {
    if (!refreshingDoc?.jobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/knowledge/${encodeURIComponent(slug)}/youtube`);
        const state = await response.json();
        const job = Array.isArray(state?.jobs)
          ? state.jobs.find((candidate: { id?: unknown }) => candidate.id === refreshingDoc.jobId)
          : null;
        if (!job || !["succeeded", "failed"].includes(job.status)) return;
        if (cancelled) return;
        setRefreshingDoc(null);
        await loadDocs();
        if (job.status === "succeeded") toast.success("YouTube questions refreshed");
        else toast.error(job.error || "YouTube refresh failed");
      } catch {
        // Keep polling through transient status-read failures.
      }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshingDoc?.jobId, slug, loadDocs]);

  async function refreshDocument(doc: Doc) {
    setRefreshingDoc({ documentId: doc.id, jobId: null });
    try {
      const res = await fetch(`/api/knowledge/${encodeURIComponent(slug)}/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh-document", documentId: doc.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.jobId !== "string") throw new Error(data?.error ?? "Refresh failed");
      setRefreshingDoc({ documentId: doc.id, jobId: data.jobId });
      toast.success("YouTube video queued for refresh");
      await loadDocs();
    } catch (error) {
      setRefreshingDoc(null);
      toast.error(error instanceof Error ? error.message : "Refresh failed");
    }
  }



  async function upload(list: FileList | null) {
    if (!list?.length) return;
    // snapshot before the caller clears the input — a live FileList empties on value=""
    const files = [...list];
    setUploading(true);
    let uploadFailures = 0;
    let indexFailures = 0;
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/knowledge/${slug}`, { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(`${file.name}: ${data?.error ?? "upload failed"}`);
        uploadFailures++;
      } else if (data?.indexError) {
        toast.error(`${file.name} uploaded, but indexing failed: ${data.indexError}`);
        indexFailures++;
      }
    }
    setUploading(false);
    if (uploadFailures === 0 && indexFailures === 0) {
      toast.success(`Uploaded and indexed ${files.length} document(s)`);
    }
    await loadDocs();
  }

  async function digest(docSlug?: string) {
    const marker = docSlug ?? "__all__";
    if (docSlug) setDigestingDoc(marker);
    else setDigestingAll(true);
    try {
      const res = await fetch(
        docSlug ? `/api/knowledge/${slug}/digest/${encodeURIComponent(docSlug)}` : `/api/knowledge/${slug}/digest`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Digestion failed");
      toast.success(docSlug ? `Indexed ${docSlug}` : `Indexed ${data.indexed} document(s)`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Digestion failed");
    } finally {
      setDigestingDoc(null);
      setDigestingAll(false);
      await loadDocs();
    }
  }

  async function removeDoc(doc: Doc) {
    if (!confirm(`Delete ${doc.slug} and its embeddings?`)) return;
    const res = await fetch(`/api/knowledge/${slug}/${encodeURIComponent(doc.slug)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toast.success("Deleted");
      await loadDocs();
    } else {
      toast.error("Delete failed");
    }
  }

  async function deleteBase() {
    if (!confirm(`Delete "${slug}" with all documents and embeddings?`)) return;
    const res = await fetch(`/api/knowledge/${slug}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Knowledge base deleted");
      router.push("/knowledge");
      router.refresh();
    } else {
      toast.error("Delete failed");
    }
  }

  async function openPreview(doc: Doc) {
    const res = await fetch(`/api/knowledge/${slug}/preview/${encodeURIComponent(doc.slug)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.url) {
      toast.error(data?.error ?? "Could not open preview");
      return;
    }
    setPreview({ doc, url: data.url, type: data.type, sourceUrl: data.sourceUrl });
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon-sm" render={<Link href="/knowledge" />} nativeButton={false} aria-label="Back to knowledge bases">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{slug}</h1>
            {docs && <Badge variant="secondary">{docs.length} document{docs.length === 1 ? "" : "s"}</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">Upload → preview → index. One ChromaDB collection per base.</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <NotionImport kb={slug} onCompleted={() => { void loadDocs(); }} />
          <YouTubeImport kb={slug} onCompleted={() => { void loadDocs(); }} />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              upload(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          <Button variant="outline" size="sm" onClick={deleteBase}>
            <Trash2 data-icon="inline-start" /> Delete base
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}
            Upload
          </Button>
          <Button size="sm" onClick={() => digest()} disabled={digestingAll || !docs?.length}>
            {digestingAll ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
            Index all
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 p-4 sm:p-6">
        {docs === null ? (
          <div className="grid h-full place-items-center">
            <Spinner className="size-6" />
          </div>
        ) : docs.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>No documents</EmptyTitle>
              <EmptyDescription>
                Upload Word, PowerPoint, Excel, PDF, CSV, EPUB, RTF or OpenDocument files.
                They are converted to markdown and stored in S3.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="h-full rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-40 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{doc.slug}</span>
                      </span>
                      {doc.error && (
                        <span className="mt-0.5 block text-xs text-destructive">{doc.error}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatBytes(doc.size)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[doc.status] ?? "outline"}>{doc.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Preview ${doc.slug}`}
                          onClick={() => openPreview(doc)}
                        >
                          <Eye />
                        </Button>
                        {doc.connector === "youtube" ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Refresh ${doc.slug}`}
                            disabled={refreshingDoc !== null || doc.status === "digesting"}
                            onClick={() => refreshDocument(doc)}
                          >
                            {refreshingDoc?.documentId === doc.id || doc.status === "digesting" ? (
                              <Spinner />
                            ) : (
                              <RefreshCw />
                            )}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Index ${doc.slug}`}
                            disabled={digestingDoc !== null || doc.status === "digesting"}
                            onClick={() => digest(doc.slug)}
                          >
                            {digestingDoc === doc.slug ? (
                              <Spinner />
                            ) : (
                              <Sparkles />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${doc.slug}`}
                          onClick={() => removeDoc(doc)}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </div>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex h-[85vh] max-w-4xl flex-col sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{preview?.doc.slug}</DialogTitle>
            <DialogDescription>
              {preview?.type === "youtube"
                ? "Extracted questions and topic links from YouTube video."
                : "Preview of the original document stored in S3."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
            {preview?.type === "youtube" ? (
              <YouTubeQuestionsPreviewLoader url={preview.url} sourceUrl={preview.sourceUrl ?? ""} />
            ) : (
              <>
                {preview?.doc.ext === "pdf" && (
                  <PDFViewer src={preview.url} fileName={preview.doc.slug} className="h-full" />
                )}
                {preview?.doc.ext === "docx" && (
                  <DocxViewerPreview src={preview.url} fileName={preview.doc.slug} className="h-full" isDark={false} onIsDarkChange={() => {}} />
                )}
                {(preview?.doc.ext === "pptx" || preview?.doc.ext === "ppsx") && (
                  <PptxViewerPreview src={preview.url} fileName={preview.doc.slug} className="h-full" />
                )}
                {preview?.doc.ext === "csv" && (
                  <CsvPreviewLoader url={preview.url} />
                )}
                {preview && !["pdf", "docx", "pptx", "ppsx", "csv"].includes(preview.doc.ext) && (
                  <TextPreviewLoader url={preview.url} />
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </main>
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

  if (error) return <p className="p-4 text-sm text-destructive">Could not load file.</p>;
  if (data === null) return <CenteredSpinner />;
  return <ScrollArea className="h-full"><CsvViewer data={data} /></ScrollArea>;
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

  if (error) return <p className="p-4 text-sm text-destructive">Could not load file.</p>;
  if (text === null) return <CenteredSpinner />;
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap p-4 font-mono text-xs">{text}</pre>
    </ScrollArea>
  );
}

function CenteredSpinner() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner className="size-6" />
    </div>
  );
}

function formatTimestamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getTimestampUrl(sourceUrl: string, seconds: number) {
  const floorSec = Math.max(0, Math.floor(seconds));
  const separator = sourceUrl.includes("?") ? "&" : "?";
  return `${sourceUrl}${separator}t=${floorSec}s`;
}

function YouTubeQuestionsPreviewLoader({ url, sourceUrl }: { url: string; sourceUrl: string }) {
  const [data, setData] = useState<YouTubeQuestionsArtifact | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Fetch failed");
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        const parsed = youtubeQuestionsArtifactSchema.safeParse(json);
        if (!parsed.success) {
          setError(true);
        } else {
          setData(parsed.data);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) return <p className="p-4 text-sm text-destructive">Could not load questions.</p>;
  if (data === null) return <CenteredSpinner />;

  if (data.questions.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-sm font-medium">No questions extracted</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No substantive questions were found in this video transcript.
          </p>
        </div>
      </div>
    );
  }

  const effectiveSourceUrl = data.sourceUrl || sourceUrl;

  return (
    <ScrollArea className="h-full">
      <div className="divide-y p-4">
        {data.questions.map((q, idx) => (
          <div key={idx} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <span className="mt-0.5 shrink-0 text-xs font-semibold text-muted-foreground">
                Q{idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug text-foreground">{q.text}</p>
                {q.topics.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {q.topics.map((t) => (
                      <Badge key={t} variant="secondary" className="text-xs font-normal">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              {effectiveSourceUrl ? (
                <a
                  href={getTimestampUrl(effectiveSourceUrl, q.startSeconds)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground hover:underline"
                >
                  {formatTimestamp(q.startSeconds)}
                </a>
              ) : (
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {formatTimestamp(q.startSeconds)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
