"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileSpreadsheet,
  FileText,
  Layers,
  Upload,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FileThumbnail } from "@/components/extend/file-thumbnail";
import type { KnowledgeDoc } from "./types";

function getFileIcon(ext: string, connector?: string) {
  if (connector === "youtube") {
    return <Video className="size-3.5 text-muted-foreground shrink-0" />;
  }
  if (connector === "notion" || connector === "notion_public") {
    return <BookOpen className="size-3.5 text-muted-foreground shrink-0" />;
  }
  switch (ext.toLowerCase()) {
    case "pdf":
      return <FileText className="size-3.5 text-muted-foreground shrink-0" />;
    case "docx":
    case "doc":
      return <FileText className="size-3.5 text-muted-foreground shrink-0" />;
    case "pptx":
    case "ppsx":
      return <Layers className="size-3.5 text-muted-foreground shrink-0" />;
    case "csv":
      return <FileSpreadsheet className="size-3.5 text-muted-foreground shrink-0" />;
    case "md":
      return <FileCode className="size-3.5 text-muted-foreground shrink-0" />;
    default:
      return <FileCode className="size-3.5 text-muted-foreground shrink-0" />;
  }
}

const PAGE_SIZE = 8;

export function DocumentList({
  documents,
  onSelectDoc,
  onOpenUpload,
  onClearSearch,
  hasSearch,
}: {
  documents: KnowledgeDoc[];
  onSelectDoc: (doc: KnowledgeDoc) => void;
  onReindexDoc?: (doc: KnowledgeDoc) => Promise<void>;
  onRefreshSource?: (doc: KnowledgeDoc) => Promise<void>;
  onDeleteDoc?: (doc: KnowledgeDoc) => Promise<void>;
  reindexingId?: string | null;
  refreshingSourceId?: string | null;
  onOpenUpload: () => void;
  onClearSearch: () => void;
  hasSearch: boolean;
}) {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    uploaded: false,
    youtube: false,
    notion: false,
  });

  // Number of items visible per section (paginated in chunks of PAGE_SIZE)
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({
    uploaded: PAGE_SIZE,
    youtube: PAGE_SIZE,
    notion: PAGE_SIZE,
  });

  function showMore(key: "uploaded" | "youtube" | "notion") {
    setVisibleCounts((prev) => ({
      ...prev,
      [key]: (prev[key] || PAGE_SIZE) + PAGE_SIZE,
    }));
  }

  function toggleSection(key: "uploaded" | "youtube" | "notion") {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const { uploadedDocs, youtubeDocs, notionDocs } = useMemo(() => {
    const uploaded: KnowledgeDoc[] = [];
    const yt: KnowledgeDoc[] = [];
    const notion: KnowledgeDoc[] = [];

    for (const doc of documents) {
      if (doc.connector === "youtube") {
        yt.push(doc);
      } else if (doc.connector === "notion" || doc.connector === "notion_public") {
        notion.push(doc);
      } else {
        uploaded.push(doc);
      }
    }

    return {
      uploadedDocs: uploaded,
      youtubeDocs: yt,
      notionDocs: notion,
    };
  }, [documents]);

  if (documents.length === 0) {
    if (hasSearch) {
      return (
        <Empty className="rounded-xl border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircle className="size-6 text-muted-foreground" />
            </EmptyMedia>
            <EmptyTitle>No matching documents</EmptyTitle>
            <EmptyDescription>No indexed content matched your search.</EmptyDescription>
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
          <EmptyTitle>No documents or sources added yet</EmptyTitle>
          <EmptyDescription>
            Upload local documents or connect Notion workspaces and YouTube channels to ground your trainers.
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={onOpenUpload} size="sm">
          Add first knowledge source
        </Button>
      </Empty>
    );
  }

  const renderCard = (doc: KnowledgeDoc) => {
    const isFailed = doc.status === "failed";
    const isIndexing = doc.status === "digesting" || doc.status === "syncing" || doc.status === "queued";

    // Dynamic border & shadow based on status
    const statusClasses = isFailed
      ? "border-destructive/70 shadow-sm shadow-destructive/10 ring-1 ring-destructive/30"
      : isIndexing
      ? "border-amber-500/70 shadow-sm shadow-amber-500/10 ring-1 ring-amber-500/30 animate-pulse"
      : "border-border/70 hover:border-orange-500/50 hover:shadow-md";

    const youtubeVideoId =
      doc.connector === "youtube"
        ? doc.externalId ||
          doc.sourceUrl?.match(/(?:v=|\/embed\/|\.be\/)([^?&]+)/)?.[1] ||
          doc.slug.replace(/^youtube_|\.json$/g, "")
        : null;

    return (
      <div
        key={doc.id}
        onClick={() => onSelectDoc(doc)}
        title={doc.error || doc.title || doc.slug}
        className={`group relative flex flex-col justify-between rounded-xl bg-card transition-all duration-200 cursor-pointer overflow-hidden select-none border ${statusClasses}`}
      >
        {/* Card Header: Icon + Title only */}
        <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 border-b border-border/40 bg-muted/10">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {getFileIcon(doc.ext, doc.connector)}
            <span
              className="text-xs font-medium text-foreground truncate group-hover:text-orange-600 transition-colors"
              title={doc.title || doc.slug}
            >
              {doc.title || doc.slug}
            </span>
          </div>

          {/* Discreet status badge only when indexing or failed */}
          {isIndexing && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0">
              <Spinner className="size-2.5" />
              <span className="capitalize">{doc.status}</span>
            </span>
          )}
          {isFailed && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-destructive shrink-0">
              <AlertCircle className="size-2.5" />
              <span>Failed</span>
            </span>
          )}
        </div>

        {/* Card Canvas Preview using Extend FileThumbnail */}
        <div className="relative w-full h-32 bg-gradient-to-b from-muted/20 to-muted/5 flex items-center justify-center p-3 overflow-hidden">
          {doc.connector === "youtube" && youtubeVideoId ? (
            <FileThumbnail
              file={{ name: doc.title || doc.slug, type: "video/youtube" }}
              previewImageUrl={`https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`}
              className="w-full h-full rounded-lg shadow-inner overflow-hidden border border-border/50"
              previewContent={
                <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                  <div className="size-8 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                    <Video className="size-4 fill-white" />
                  </div>
                </div>
              }
            />
          ) : doc.connector === "notion" || doc.connector === "notion_public" ? (
            <FileThumbnail
              file={{ name: doc.title || doc.slug, type: "text/markdown" }}
              className="w-4/5 h-full rounded-t-lg bg-background border border-border/80 shadow-xs group-hover:-translate-y-1 transition-transform"
              previewContent={
                <div className="p-3 flex flex-col gap-2 w-full h-full">
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="size-3.5 text-stone-600 dark:text-stone-300" />
                    <div className="h-2 w-16 bg-muted-foreground/30 rounded-full" />
                  </div>
                  <div className="h-1.5 w-full bg-muted rounded-full mt-1" />
                  <div className="h-1.5 w-5/6 bg-muted rounded-full" />
                  <div className="h-1.5 w-2/3 bg-muted rounded-full" />
                </div>
              }
            />
          ) : (
            <FileThumbnail
              file={{ name: doc.slug, type: `application/${doc.ext}` }}
              className="w-4/5 h-full rounded-t-lg bg-background border border-border/80 shadow-xs group-hover:-translate-y-1 transition-transform"
              previewContent={
                <div className="p-3 flex flex-col gap-2 w-full h-full">
                  <div className="flex items-center justify-between">
                    <div className="h-2.5 w-14 bg-muted-foreground/30 rounded-full" />
                  </div>
                  <div className="h-1.5 w-full bg-muted rounded-full mt-1.5" />
                  <div className="h-1.5 w-4/5 bg-muted rounded-full" />
                  <div className="h-1.5 w-full bg-muted rounded-full" />
                  <div className="h-1.5 w-3/5 bg-muted rounded-full" />
                </div>
              }
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* SECTION 1: UPLOADED FILES */}
      {uploadedDocs.length > 0 && (
        <section className="space-y-3.5">
          <button
            type="button"
            onClick={() => toggleSection("uploaded")}
            className="flex items-center justify-between w-full py-1 text-left group select-none cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <Upload className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground tracking-tight">Uploaded Files</h3>
              <span className="text-xs text-muted-foreground font-medium">({uploadedDocs.length})</span>
            </div>
            <div className="size-6 rounded-md flex items-center justify-center text-muted-foreground group-hover:text-foreground transition-colors">
              {collapsedSections.uploaded ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            </div>
          </button>

          {!collapsedSections.uploaded && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {uploadedDocs.slice(0, visibleCounts.uploaded).map(renderCard)}
              </div>
              {uploadedDocs.length > visibleCounts.uploaded && (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showMore("uploaded")}
                    className="text-xs h-8 px-4"
                  >
                    Show more
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* SECTION 2: YOUTUBE */}
      {youtubeDocs.length > 0 && (
        <section className="space-y-3.5">
          <button
            type="button"
            onClick={() => toggleSection("youtube")}
            className="flex items-center justify-between w-full py-1 text-left group select-none cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <Video className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground tracking-tight">YouTube</h3>
              <span className="text-xs text-muted-foreground font-medium">({youtubeDocs.length})</span>
            </div>
            <div className="size-6 rounded-md flex items-center justify-center text-muted-foreground group-hover:text-foreground transition-colors">
              {collapsedSections.youtube ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            </div>
          </button>

          {!collapsedSections.youtube && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {youtubeDocs.slice(0, visibleCounts.youtube).map(renderCard)}
              </div>
              {youtubeDocs.length > visibleCounts.youtube && (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showMore("youtube")}
                    className="text-xs h-8 px-4"
                  >
                    Show more
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* SECTION 3: NOTION */}
      {notionDocs.length > 0 && (
        <section className="space-y-3.5">
          <button
            type="button"
            onClick={() => toggleSection("notion")}
            className="flex items-center justify-between w-full py-1 text-left group select-none cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <BookOpen className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground tracking-tight">Notion</h3>
              <span className="text-xs text-muted-foreground font-medium">({notionDocs.length})</span>
            </div>
            <div className="size-6 rounded-md flex items-center justify-center text-muted-foreground group-hover:text-foreground transition-colors">
              {collapsedSections.notion ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            </div>
          </button>

          {!collapsedSections.notion && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {notionDocs.slice(0, visibleCounts.notion).map(renderCard)}
              </div>
              {notionDocs.length > visibleCounts.notion && (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showMore("notion")}
                    className="text-xs h-8 px-4"
                  >
                    Show more
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
