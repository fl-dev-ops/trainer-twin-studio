"use client";

import { CreditsPager, usePage } from "@/components/credits/credits-pager";
import type { CreditEntry } from "@/lib/minutes";
import { cn } from "@/lib/utils";

/** Same order as the Billing page's invoices: what, date, one detail, then the amount on the right. */
const GRID = "grid grid-cols-[minmax(0,1fr)_96px_minmax(0,140px)_88px] items-center gap-4";
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Credits added, newest first, 20 a page: the org's credits (Usage) or what one learner was given (their page). Each row
 * is one addition, never edited. 1 credit = 1 minute of practice. The third column is who added it (learners' credits)
 * or when it expires (the org's credits, which all come from TrainerTwin and are the only ones that expire).
 */
export function CreditsHistoryTable({ rows, empty, column = "addedBy" }: {
  rows: CreditEntry[];
  empty: string;
  column?: "addedBy" | "expires";
}) {
  const { rows: shown, ...pager } = usePage(rows);
  return (
    <div className="overflow-hidden rounded-tt-lg border border-(--card-border) bg-card shadow-card">
      <div className={`${GRID} bg-(--sidebar) px-5 py-2.5 text-overline font-medium tracking-overline uppercase text-(--text-secondary)`}>
        <span>Note</span>
        <span>Date</span>
        <span>{column === "expires" ? "Expires" : "Added by"}</span>
        <span className="text-right">Credits</span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 border-t border-(--border) px-5 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((row) => (
            <li key={row.id} className={`${GRID} border-t border-(--border) px-5 py-3 text-sm`}>
              <span className="truncate">{row.note ?? "—"}</span>
              <time dateTime={row.at} title={new Date(row.at).toLocaleString()} className="text-xs text-muted-foreground tabular-nums">{when(row.at)}</time>
              {column === "expires" ? (
                <span className={cn("text-xs tabular-nums text-muted-foreground", row.expired && "text-caution")}>
                  {row.expiresAt ? `${row.expired ? "Expired " : ""}${when(row.expiresAt)}` : "Never"}
                </span>
              ) : (
                <span className="truncate text-muted-foreground">{row.by ?? "TrainerTwin"}</span>
              )}
              <span className={`text-right font-medium tabular-nums ${row.minutes < 0 ? "text-caution" : ""}`}>{row.minutes < 0 ? "−" : "+"}{Math.abs(row.minutes).toLocaleString()} <span className="font-normal text-muted-foreground">min</span></span>
            </li>
          ))}
        </ul>
      )}
      <CreditsPager {...pager} />
    </div>
  );
}
