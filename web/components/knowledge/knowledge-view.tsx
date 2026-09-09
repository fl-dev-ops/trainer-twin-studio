"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageContainer } from "@/components/page-container";
import { KnowledgeHeader } from "./knowledge-header";
import { KnowledgeActionBar } from "./knowledge-action-bar";
import { DocumentList } from "./document-list";
import { KnowledgeUploadModal } from "./knowledge-upload-modal";
import { DocumentDetailDrawer } from "./document-detail-drawer";
import { Knowledge3DView } from "./knowledge-3d-view";
import { fetchDocuments, fetchStats, searchKnowledge } from "@/lib/knowledge/api";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import type {
  KnowledgeDoc,
  KnowledgeSearchHit,
  KnowledgeStats,
  ViewMode,
} from "./types";

export function KnowledgeView({
  initialDocs = [],
  initialStats = null,
}: {
  initialDocs?: KnowledgeDoc[];
  initialStats?: KnowledgeStats | null;
}) {
  const queryClient = useQueryClient();

  // Queries backed by TanStack Query cache (0ms instant switches, shared cache)
  const {
    data: documents = initialDocs,
    isFetching: isFetchingDocs,
  } = useQuery({
    queryKey: knowledgeKeys.documents(),
    queryFn: fetchDocuments,
    initialData: initialDocs.length > 0 ? initialDocs : undefined,
  });

  const {
    data: stats = initialStats,
    isFetching: isFetchingStats,
  } = useQuery({
    queryKey: knowledgeKeys.stats(),
    queryFn: fetchStats,
    initialData: initialStats ?? undefined,
  });

  const refreshing = isFetchingDocs || isFetchingStats;

  const [searchInput, setSearchInput] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [searchHits, setSearchHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  // Modals & Drawers
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reindexingId, setReindexingId] = useState<string | null>(null);

  // 3D View lazy mount state
  const [hasOpened3D, setHasOpened3D] = useState(false);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    if (mode === "3d") {
      setHasOpened3D(true);
    }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    } catch {
      toast.error("Failed to refresh knowledge base");
    }
  }, [queryClient]);

  async function handleReindex(doc: KnowledgeDoc) {
    setReindexingId(doc.id);
    try {
      const res = await fetch(`/api/knowledge/documents/${doc.id}`, {
        method: "POST",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || "Reindex failed");
      }
      toast.success(`Successfully re-indexed into ${data.chunkCount} chunks`);
      await refreshData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reindex failed");
    } finally {
      setReindexingId(null);
    }
  }

  async function handleDelete(doc: KnowledgeDoc) {
    try {
      const res = await fetch(`/api/knowledge/documents/${doc.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || "Delete failed");
      }
      toast.success(`Deleted ${doc.slug}`);
      if (selectedDoc?.id === doc.id) {
        setDrawerOpen(false);
        setSelectedDoc(null);
      }
      await refreshData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function handleSelectDoc(doc: KnowledgeDoc) {
    setSelectedDoc(doc);
    setDrawerOpen(true);
  }

  async function handleSelectDocId(docId: string) {
    let doc = documents.find((d) => d.id === docId);
    if (!doc) {
      const refreshedDocs = await queryClient.fetchQuery({
        queryKey: knowledgeKeys.documents(),
        queryFn: fetchDocuments,
      });
      doc = refreshedDocs.find((d) => d.id === docId);
    }
    if (doc) {
      handleSelectDoc(doc);
    }
  }

  async function handleSearch() {
    const query = searchInput.trim();
    if (!query) return clearSearch();

    setSearching(true);
    try {
      const hits = await queryClient.fetchQuery({
        queryKey: knowledgeKeys.search(query),
        queryFn: () => searchKnowledge(query),
        staleTime: 30_000,
      });
      setSearchedQuery(query);
      setSearchHits(hits);
      setViewMode("list");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  function handleSearchInputChange(value: string) {
    setSearchInput(value);
    if (!value.trim()) clearSearch();
  }

  function clearSearch() {
    setSearchInput("");
    setSearchedQuery("");
    setSearchHits(null);
  }

  const visibleDocuments = useMemo(() => {
    if (!searchedQuery || !searchHits) return documents;
    const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
    return [...new Set(searchHits.map((hit) => hit.docId))]
      .map((id) => documentsById.get(id))
      .filter((doc): doc is KnowledgeDoc => Boolean(doc));
  }, [documents, searchHits, searchedQuery]);

  return (
    <main className="min-h-0 flex-1 overflow-auto p-5 sm:p-8">
      <PageContainer size="narrow" className="flex flex-col gap-6">
        <KnowledgeHeader
          stats={stats}
          onOpenUpload={() => setUploadOpen(true)}
        />

        <KnowledgeActionBar
          searchQuery={searchInput}
          onSearchChange={handleSearchInputChange}
          onSearch={handleSearch}
          searching={searching}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          onRefresh={refreshData}
          refreshing={refreshing}
        />

        {/* View Switcher: List or 3D Vector Space (persisted in DOM for instant 0ms toggle) */}
        <div className={viewMode === "list" ? "block" : "hidden"}>
          <DocumentList
            documents={visibleDocuments}
            onSelectDoc={handleSelectDoc}
            onReindexDoc={handleReindex}
            onDeleteDoc={handleDelete}
            reindexingId={reindexingId}
            onOpenUpload={() => setUploadOpen(true)}
            onClearSearch={clearSearch}
            hasSearch={Boolean(searchedQuery)}
          />
        </div>

        {hasOpened3D && (
          <div className={viewMode === "3d" ? "block" : "hidden"}>
            <Knowledge3DView
              onSelectDocId={handleSelectDocId}
              isVisible={viewMode === "3d"}
            />
          </div>
        )}

        {/* Upload Modal */}
        <KnowledgeUploadModal
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          onSuccess={refreshData}
        />

        {/* Document Detail Drawer */}
        <DocumentDetailDrawer
          doc={selectedDoc ? documents.find((d) => d.id === selectedDoc.id) ?? selectedDoc : null}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onReindexDoc={handleReindex}
          onDeleteDoc={handleDelete}
          reindexing={reindexingId === selectedDoc?.id}
        />
      </PageContainer>
    </main>
  );
}
