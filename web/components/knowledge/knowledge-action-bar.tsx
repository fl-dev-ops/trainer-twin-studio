"use client";

import { RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function KnowledgeActionBar({
  searchQuery,
  onSearchChange,
  onSearch,
  searching,
  onRefresh,
  refreshing = false,
}: {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearch: () => void;
  searching: boolean;
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
    </div>
  );
}
