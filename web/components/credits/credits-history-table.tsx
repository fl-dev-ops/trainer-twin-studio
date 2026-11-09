"use client";

import { CreditsPager, usePage } from "@/components/credits/credits-pager";
import type { CreditEntry } from "@/lib/minutes";

const GRID = "grid grid-cols-[150px_110px_minmax(0,1fr)_minmax(0,180px)] items-center gap-3";
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Credits added, newest first, 20 a page: the org's top-ups or what one learner was given. Each row is one addition, never
 * edited, so the rows add up to everything that was ever added. 1 credit = 1 minute of practice.
 */
export function CreditsHistoryTable({ rows, empty, byFallback = "TrainerTwin" }: {
  rows: CreditEntry[];
  empty: string;
  /** Who added a row with no recorded person (top-ups come from TrainerTwin). */
  byFallback?: string;
}) {
  const { rows: shown, ...pager } = usePage(rows);
  return (
    <div className="overflow-hidden rounded-tt-lg border border-(--card-border) bg-card shadow-card">
      <div className={`${GRID} bg-(--sidebar) px-5 py-2.5 text-overline font-medium tracking-overline uppercase text-(--text-secondary)`}>
        <span>Date</span>
        <span>Credits</span>
        <span>Note</span>
        <span>Added by</span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 border-t border-(--border) px-5 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((row) => (
            <li key={row.id} className={`${GRID} border-t border-(--border) px-5 py-3 text-sm`}>
              <time dateTime={row.at} className="text-muted-foreground tabular-nums">{when(row.at)}</time>
              <span className={`font-medium tabular-nums ${row.minutes < 0 ? "text-caution" : ""}`}>{row.minutes < 0 ? "−" : "+"}{Math.abs(row.minutes).toLocaleString()} <span className="font-normal text-muted-foreground">min</span></span>
              <span className="truncate text-muted-foreground">{row.note ?? "—"}</span>
              <span className="truncate">{row.by ?? byFallback}</span>
            </li>
          ))}
        </ul>
      )}
      <CreditsPager {...pager} />
    </div>
  );
}
