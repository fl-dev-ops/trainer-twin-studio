"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 20;

/** One page of `rows` (20 at a time). A page past the end (the rows shrank, say after a search) falls back to the last. */
export function usePage<T>(rows: T[]) {
  const [wanted, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(wanted, pages - 1);
  return { page, pages, total: rows.length, setPage, rows: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
}

/** "21–40 of 45" with Previous and Next under a table; nothing when everything fits on one page. */
export function CreditsPager({ page, pages, total, setPage }: Omit<ReturnType<typeof usePage>, "rows">) {
  if (pages <= 1) return null;
  const from = page * PAGE_SIZE + 1;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-(--border) px-5 py-2.5 text-sm">
      <span className="text-muted-foreground tabular-nums">
        {from}–{Math.min(total, from + PAGE_SIZE - 1)} of {total}
      </span>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
          <ChevronLeft data-icon="inline-start" /> Previous
        </Button>
        <Button variant="ghost" size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
          Next <ChevronRight data-icon="inline-end" />
        </Button>
      </span>
    </nav>
  );
}
