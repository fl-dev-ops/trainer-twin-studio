"use client";

import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { AddCreditsDialog } from "@/components/credits/add-credits-dialog";
import { CreditsHistoryTable } from "@/components/credits/credits-history-table";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { LOW_LEARNER_MINUTES } from "@/lib/minutes-config";
import { cn } from "@/lib/utils";

function useLearnerCredits(email: string) {
  return useQuery({ queryKey: ["minutes.learner", email], queryFn: () => api.minutes.learner.query({ email }) });
}

/**
 * A learner's credits beside their name: left, given and used (shared by every twin and role play), with Add credits.
 * Credits are only ever added; what's left is given minus used.
 */
export function LearnerCreditsSummary({ email, name }: { email: string; name: string }) {
  const [adding, setAdding] = useState(false);
  const { data } = useLearnerCredits(email);
  const usedPct = data && data.givenMinutes > 0 ? Math.min(100, Math.round((data.usedMinutes / data.givenMinutes) * 100)) : 0;
  const low = data ? data.balanceMinutes < LOW_LEARNER_MINUTES : false;

  return (
    <section aria-label="Credits" className="flex items-center gap-6 rounded-tt-lg border border-(--card-border) bg-card px-5 py-4 shadow-card">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="m-0 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">Credits left</p>
        <p className={cn("m-0 text-2xl font-semibold tabular-nums tracking-title", low && "text-caution")}>
          {data ? data.balanceMinutes.toLocaleString() : "…"} <span className="text-base font-normal text-muted-foreground">min</span>
        </p>
        <span className="block h-1.5 w-44 max-w-full overflow-hidden rounded-full bg-(--tone-control)">
          <span className={cn("block h-full w-(--w) rounded-full", usedPct >= 90 ? "bg-caution" : "bg-foreground")} style={{ "--w": `${usedPct}%` } as CSSProperties} />
        </span>
        <p className="m-0 text-xs text-muted-foreground tabular-nums">{data ? `${data.usedMinutes} of ${data.givenMinutes} min used` : "Loading…"}</p>
      </div>
      <Button variant="brand" disabled={!data} onClick={() => setAdding(true)}>
        <Plus data-icon="inline-start" /> Add credits
      </Button>

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

/** Every credit added to a learner, newest first (the Credits tab of their page). */
export function LearnerCreditsHistory({ email }: { email: string }) {
  const { data } = useLearnerCredits(email);
  return <CreditsHistoryTable rows={data?.added ?? []} empty={data ? "No credits added yet." : "Loading…"} />;
}
