"use client";

import { Box, List, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ViewMode } from "./types";

export function KnowledgeActionBar({
  searchQuery,
  onSearchChange,
  onSearch,
  searching,
  viewMode,
  onViewModeChange,
  onRefresh,
  refreshing = false,
}: {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearch: () => void;
  searching: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <div className="relative min-w-0 max-w-md flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search knowledge by meaning..."
            aria-label="Search indexed knowledge"
            className="h-9 pl-9 pr-8 text-sm"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button
          type="submit"
          variant="outline"
          size="lg"
          disabled={!searchQuery.trim() || searching}
        >
          {searching ? <Spinner data-icon="inline-start" /> : <Search data-icon="inline-start" />}
          Search
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh documents"
          aria-label="Refresh documents"
        >
          <RefreshCw className={refreshing ? "animate-spin text-muted-foreground" : undefined} />
        </Button>
      </form>

      <div className="flex items-center rounded-lg border bg-muted/40 p-0.5">
        <Button
          variant={viewMode === "list" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("list")}
        >
          <List data-icon="inline-start" /> List
        </Button>
        <Button
          variant={viewMode === "3d" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("3d")}
        >
          <Box data-icon="inline-start" /> 3D space
        </Button>
      </div>
    </div>
  );
}
