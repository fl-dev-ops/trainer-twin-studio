"use client";

import { useState } from "react";
import { CreditsIcon } from "@/components/icons";
import { CreditsHistoryTable } from "@/components/credits/credits-history-table";
import { LearnerCreditsTable } from "@/components/credits/learner-credits-table";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { SearchInput } from "@/components/search-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/lib/app-router";

export type OrgCredits = inferRouterOutputs<AppRouter>["minutes"]["org"];

/**
 * The Credits page: what the organization has left to give its learners, then two tabs: what each learner was
 * assigned (given, used, left; searchable) and every top-up to the account. 1 credit = 1 minute of practice, used by
 * learners' calls with twins and role plays.
 */
export function CreditsPage({ credits }: { credits: OrgCredits }) {
  const [query, setQuery] = useState("");
  const low = credits.balanceMinutes < credits.defaultMinutes;
  const q = query.trim().toLowerCase();
  const learners = q ? credits.learners.filter((row) => row.email.includes(q) || row.name?.toLowerCase().includes(q)) : credits.learners;

  return (
    <PageContainer>
      <PageHeader icon={CreditsIcon} title="Credits" description="Prepaid practice minutes for your learners. 1 credit = 1 minute." />

      <section className="mt-8 max-w-xl rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
        <p className="m-0 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">Remaining credits</p>
        <p className={`m-0 mt-2 text-4xl font-semibold tabular-nums tracking-title ${low ? "text-caution" : ""}`}>
          {credits.balanceMinutes.toLocaleString()} <span className="text-lg font-normal text-muted-foreground">min</span>
        </p>
        <p className="m-0 mt-2 text-sm text-muted-foreground">
          {low
            ? `Not enough to give a new learner their ${credits.defaultMinutes} min. Contact TrainerTwin to top up.`
            : `Left to give your learners. Each new learner gets ${credits.defaultMinutes} min; give more on their page (up to ${credits.maxMinutes} min each).`}
        </p>
      </section>

      <Tabs defaultValue="assigned" className="mt-10 gap-4">
        <TabsList>
          <TabsTrigger value="assigned">Assigned</TabsTrigger>
          <TabsTrigger value="topups">Top-up history</TabsTrigger>
        </TabsList>
        <TabsContent value="assigned" className="flex flex-col gap-4">
          <div className="w-72 max-w-full">
            <SearchInput placeholder="Search learners" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search learners" />
          </div>
          <LearnerCreditsTable
            rows={learners}
            empty={q ? `No learner matches “${query.trim()}”.` : "No learner has credits yet. They get theirs when you invite or assign them."}
          />
        </TabsContent>
        <TabsContent value="topups">
          <CreditsHistoryTable rows={credits.topups} empty="No credits added yet. Contact TrainerTwin to top up your account." />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
