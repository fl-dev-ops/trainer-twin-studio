"use client";

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  FileCode,
  FileSpreadsheet,
  FileText,
  Layers,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import type { KnowledgeDoc } from "./types";

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
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function getFileIcon(ext: string) {
  switch (ext.toLowerCase()) {
    case "pdf":
      return <FileText className="size-4 text-red-500" />;
    case "docx":
    case "doc":
      return <FileText className="size-4 text-blue-500" />;
    case "pptx":
    case "ppsx":
      return <Layers className="size-4 text-amber-500" />;
    case "csv":
      return <FileSpreadsheet className="size-4 text-emerald-500" />;
    default:
      return <FileCode className="size-4 text-muted-foreground" />;
  }
}

export function DocumentList({
  documents,
  onSelectDoc,
  onReindexDoc,
  onDeleteDoc,
  reindexingId,
  onOpenUpload,
  onClearSearch,
  hasSearch,
}: {
  documents: KnowledgeDoc[];
  onSelectDoc: (doc: KnowledgeDoc) => void;
  onReindexDoc: (doc: KnowledgeDoc) => Promise<void>;
  onDeleteDoc: (doc: KnowledgeDoc) => Promise<void>;
  reindexingId: string | null;
  onOpenUpload: () => void;
  onClearSearch: () => void;
  hasSearch: boolean;
}) {
  const [docToDelete, setDocToDelete] = useState<KnowledgeDoc | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!docToDelete) return;
    setDeleting(true);
    try {
      await onDeleteDoc(docToDelete);
      setDocToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  if (documents.length === 0) {
    if (hasSearch) {
      return (
        <Empty className="rounded-xl border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircle className="size-6 text-muted-foreground" />
            </EmptyMedia>
            <EmptyTitle>No matching documents</EmptyTitle>
            <EmptyDescription>
              No indexed content matched your search.
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        </Empty>
      );
    }

    return (
      <Empty className="rounded-xl border border-dashed py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText className="size-6 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>No documents uploaded yet</EmptyTitle>
          <EmptyDescription>
            Upload curriculum, textbooks, guidelines, or presentation decks to ground your trainers.
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={onOpenUpload} size="sm">
          Upload first document
        </Button>
      </Empty>
    );
  }

  return (
    <>
      <div className="rounded-xl border bg-card shadow-xs overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead className="w-[45%]">Document</TableHead>
              <TableHead className="w-[15%]">Format / Size</TableHead>
              <TableHead className="w-[15%]">Status</TableHead>
              <TableHead className="w-[15%]">Indexed</TableHead>
              <TableHead className="w-[10%] text-right pr-4">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((doc) => {
              const isReindexing = reindexingId === doc.id;
              return (
                <TableRow
                  key={doc.id}
                  className="cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => onSelectDoc(doc)}
                >
                  {/* Title & Slug */}
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted border">
                        {getFileIcon(doc.ext)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground hover:underline">
                          {doc.title || doc.slug}
                        </div>
                        <div className="truncate text-xs text-muted-foreground font-mono">
                          {doc.slug}
                        </div>
                      </div>
                    </div>
                  </TableCell>

                  {/* Format & Size */}
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="font-semibold uppercase tracking-wider text-foreground/80">
                        {doc.ext}
                      </span>
                      <span>•</span>
                      <span>{formatBytes(doc.size)}</span>
                    </div>
                  </TableCell>

                  {/* Status Badge */}
                  <TableCell>
                    {doc.status === "indexed" ? (
                      <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 text-[11px]">
                        <CheckCircle2 className="size-3" />
                        <span>Indexed</span>
                      </Badge>
                    ) : doc.status === "digesting" ? (
                      <Badge variant="outline" className="gap-1 border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10 text-[11px]">
                        <Spinner className="size-3" />
                        <span>Digesting</span>
                      </Badge>
                    ) : doc.status === "failed" ? (
                      <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive bg-destructive/10 text-[11px]" title={doc.error || "Failed"}>
                        <AlertCircle className="size-3" />
                        <span>Failed</span>
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[11px]">
                        {doc.status}
                      </Badge>
                    )}
                  </TableCell>

                  {/* Date */}
                  <TableCell className="text-xs text-muted-foreground" suppressHydrationWarning>
                    {formatDate(doc.indexedAt || doc.createdAt)}
                  </TableCell>

                  {/* Actions */}
                  <TableCell className="text-right pr-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onSelectDoc(doc)}
                        title="View chunks and file preview"
                        className="size-8"
                      >
                        <Eye className="size-3.5 text-muted-foreground" />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onReindexDoc(doc)}
                        disabled={isReindexing}
                        title="Re-index document"
                        className="size-8"
                      >
                        <RefreshCw className={`size-3.5 text-muted-foreground ${isReindexing ? "animate-spin text-primary" : ""}`} />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDocToDelete(doc)}
                        title="Delete document"
                        className="size-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={docToDelete !== null} onOpenChange={(open) => !open && setDocToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">{docToDelete?.slug}</span>?
              This will remove the file from S3 and erase all indexed chunks from the organization&apos;s vector collection.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDocToDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
              Delete document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
