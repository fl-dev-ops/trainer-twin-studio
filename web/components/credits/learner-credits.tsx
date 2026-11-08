"use client";

import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { AddCreditsDialog } from "@/components/credits/add-credits-dialog";
import { CreditsHistoryTable } from "@/components/credits/credits-history-table";
import { SectionHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A learner's credits on their page: a small summary (left, given, used; shared by every twin and role play) with
 * Add credits, then every credit added to them. Credits are only ever added; what's left is given minus used.
 */
export function LearnerCredits({ email, name }: { email: string; name: string }) {
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ["minutes.learner", email], queryFn: () => api.minutes.learner.query({ email }) });
  const usedPct = data && data.givenMinutes > 0 ? Math.min(100, Math.round((data.usedMinutes / data.givenMinutes) * 100)) : 0;
  const low = data ? data.balanceMinutes < 5 : false;

  return (
    <section aria-label="Credits" className="mt-8 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-tt-lg border border-(--card-border) bg-card px-5 py-4 shadow-card">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="m-0 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">Credits left</p>
          <p className={cn("m-0 text-2xl font-semibold tabular-nums tracking-title", low && "text-caution")}>
            {data ? data.balanceMinutes.toLocaleString() : "…"} <span className="text-base font-normal text-muted-foreground">min</span>
          </p>
          <span className="block h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-(--tone-control)">
            <span className={cn("block h-full w-(--w) rounded-full", usedPct >= 90 ? "bg-caution" : "bg-foreground")} style={{ "--w": `${usedPct}%` } as CSSProperties} />
          </span>
          <p className="m-0 text-xs text-muted-foreground tabular-nums">
            {data ? `${data.usedMinutes} of ${data.givenMinutes} min used · shared by twins and role plays` : "Loading…"}
          </p>
        </div>
        <Button variant="brand" disabled={!data} onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" /> Add credits
        </Button>
      </div>

      <SectionHeader title="Credits added" note={`Every credit given to ${name}, newest first`} />
      <CreditsHistoryTable rows={data?.added ?? []} empty={data ? "No credits added yet." : "Loading…"} />

      {data ? (
        <AddCreditsDialog
          email={email}
          name={name}
          open={adding}
          onOpenChange={setAdding}
          givenMinutes={data.givenMinutes}
          maxMinutes={data.maxMinutes}
          orgBalanceMinutes={data.orgBalanceMinutes}
        />
      ) : null}
    </section>
  );
}
