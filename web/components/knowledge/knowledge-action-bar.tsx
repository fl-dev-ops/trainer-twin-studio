"use client";

import { RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SearchInput } from "@/components/search-input";
import { InputGroupButton } from "@/components/ui/input-group";

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
        <SearchInput
          className="h-9 min-w-0 max-w-md flex-1"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search knowledge by meaning..."
          aria-label="Search indexed knowledge"
          end={
            searchQuery ? (
              <InputGroupButton size="icon-xs" onClick={() => onSearchChange("")} aria-label="Clear search">
                <X />
              </InputGroupButton>
            ) : null
          }
        />
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
