"use client";

import { CreditsIcon } from "@/components/icons";
import { CreditsHistoryTable } from "@/components/credits/credits-history-table";
import { PageContainer } from "@/components/page-container";
import { LearnerCreditsTable } from "@/components/credits/learner-credits-table";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/lib/app-router";

export type OrgCredits = inferRouterOutputs<AppRouter>["minutes"]["org"];

/**
 * The Credits page: what the organization has left to give its learners, and every credit added to the account
 * (top-ups), with each learner's balance. 1 credit = 1 minute of practice, used by learners' calls with twins and role plays.
 */
export function CreditsPage({ credits }: { credits: OrgCredits }) {
  const low = credits.balanceMinutes < credits.defaultMinutes;
  return (
    <PageContainer>
      <PageHeader icon={CreditsIcon} title="Credits" description="Prepaid practice minutes for your learners. 1 credit = 1 minute." />

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
          <p className="m-0 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">Remaining credits</p>
          <p className={`m-0 mt-2 text-4xl font-semibold tabular-nums tracking-title ${low ? "text-caution" : ""}`}>
            {credits.balanceMinutes.toLocaleString()} <span className="text-lg font-normal text-muted-foreground">min</span>
          </p>
          <p className="m-0 mt-2 text-sm text-muted-foreground">
            {low
              ? `Not enough to give a new learner their ${credits.defaultMinutes} min. Contact TrainerTwin to top up.`
              : `Left to give your learners. Each new learner gets ${credits.defaultMinutes} min; give more on their page (up to ${credits.maxMinutes} min each).`}
          </p>
        </div>
        <div className="rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
          <p className="m-0 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">Added to your account</p>
          <p className="m-0 mt-2 text-4xl font-semibold tabular-nums tracking-title">
            {credits.addedMinutes.toLocaleString()} <span className="text-lg font-normal text-muted-foreground">min</span>
          </p>
          <p className="m-0 mt-2 text-sm text-muted-foreground">
            {(credits.addedMinutes - credits.balanceMinutes).toLocaleString()} min given to learners so far.
          </p>
        </div>
      </section>

      <Tabs defaultValue="learners" className="mt-10 gap-4">
        <TabsList>
          <TabsTrigger value="learners">Learner balances</TabsTrigger>
          <TabsTrigger value="topups">Top-up history</TabsTrigger>
        </TabsList>
        <TabsContent value="learners">
          <LearnerCreditsTable rows={credits.learners} />
        </TabsContent>
        <TabsContent value="topups">
          <CreditsHistoryTable rows={credits.topups} empty="No credits added yet. Contact TrainerTwin to top up your account." />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
