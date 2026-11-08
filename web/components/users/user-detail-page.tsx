"use client";

import { UserAvatar } from "@/components/user-avatar";
import { TWIN_SESSION_GRID, TwinSessionItem, type TwinSessionItemData } from "@/components/twin/twin-session-item";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { LearnerCreditsHistory, LearnerCreditsSummary } from "@/components/credits/learner-credits";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type UserDetail = {
  user: { id: string; name: string; email: string; image: string | null };
  sessions: TwinSessionItemData[];
};

/** One user's twin sessions across all twins (/users/<id>), reached from a Learners tab or the Users page. */
export function UserDetailPage({ user, sessions }: UserDetail) {
  return (
    <PageContainer>
      <PageHeader back={{ href: "/users" }} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-4">
          <UserAvatar user={user} size="2xl" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-section-title font-semibold">{user.name || user.email}</span>
            <span className="truncate text-sm text-muted-foreground">{user.email}</span>
          </span>
        </div>
        <LearnerCreditsSummary email={user.email} name={user.name || user.email} />
      </div>

      <Tabs defaultValue="sessions" className="mt-10 gap-4">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="credits">Credits</TabsTrigger>
        </TabsList>

        <TabsContent value="sessions">
          <Card size="lg" className="gap-0 py-0">
            <div className={cn(TWIN_SESSION_GRID, "border-b px-5 py-2.5 text-body-s font-medium uppercase text-muted-foreground max-sm:hidden")}>
              <span /> {/* avatar */}
              <span>Learner</span>
              <span>Topics</span>
              <span>Duration</span>
              <span>Helpfulness</span>
              <span /> {/* arrow */}
            </div>
            <ul className="m-0 flex list-none flex-col p-0">
              {sessions.length === 0 ? (
                <li className="p-8 text-center text-sm text-muted-foreground">No sessions yet.</li>
              ) : (
                sessions.map((session, idx) => (
                  <TwinSessionItem
                    key={session.id}
                    session={session}
                    divider={idx > 0}
                  />
                ))
              )}
            </ul>
          </Card>
        </TabsContent>

        <TabsContent value="credits">
          <LearnerCreditsHistory email={user.email} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
