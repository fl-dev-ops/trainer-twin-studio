"use client";

import { UserAvatar } from "@/components/user-avatar";
import { TWIN_SESSION_GRID, TwinSessionItem, type TwinSessionItemData } from "@/components/twin/twin-session-item";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { LearnerMinutes } from "@/components/users/learner-minutes";
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

      <PageContainer className="mt-6 flex-row items-center gap-4">
        <UserAvatar user={user} size="2xl" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-section-title font-semibold">{user.name || user.email}</span>
          <span className="truncate text-sm text-muted-foreground">{user.email}</span>
        </span>
      </PageContainer>

      <div className="mt-8">
        <LearnerMinutes email={user.email} />
      </div>

      <SectionHeader
        title="Sessions"
        note="Conversations this learner had with your twins"
        className="mt-10"
      />

      <Card size="lg" className="mt-4 gap-0 py-0">
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
    </PageContainer>
  );
}
