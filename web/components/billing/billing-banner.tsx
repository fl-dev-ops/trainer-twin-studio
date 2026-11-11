"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/billing/pricing";

/**
 * Across the studio (specs/billing.md rule 15): a paused plan, or a Paid renewal due, with a link to Settings ›
 * Billing. Nothing for learners or orgs without billing (the query is refused or has nothing to say).
 */
export function BillingBanner() {
  // Its own key (useApi caches pages in another shape) under the tab's prefix, so the tab's refreshes reach it.
  const { data } = useQuery({ queryKey: ["billing.overview", "banner"], queryFn: () => api.billing.overview.query(), staleTime: 5 * 60_000, retry: false });
  if (!data?.billed) return null;
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  if (data.pausedAt) {
    return (
      <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
        Your plan is paused: invoice {data.overdueInvoice?.number ?? ""} is overdue, so no new calls can start and no credits can be given.{" "}
        <Link href="/billing" className="font-medium underline">Pay to continue</Link>
      </div>
    );
  }
  if (data.dueInvoice) {
    return (
      <div className="border-b bg-muted px-4 py-2 text-sm">
        Invoice {data.dueInvoice.number} ({formatMoney(data.dueInvoice.totalCents, data.dueInvoice.currency)}) is due {day(data.dueInvoice.dueDate)}.{" "}
        <Link href="/billing" className="font-medium underline">See billing</Link>
      </div>
    );
  }
  return null;
}
