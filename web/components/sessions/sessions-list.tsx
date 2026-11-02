"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SessionsIcon } from "@/components/icons";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { PageContainer } from "@/components/page-container";
import { SessionFilters } from "@/components/sessions/session-filters";
import { SessionTime } from "@/components/sessions/session-time";
import { UserAvatar } from "@/components/user-avatar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { SessionsListData } from "@/lib/pages/sessions";

const STATUS_LABEL: Record<string, string> = {
  assigned: "Not started",
  activating: "Starting",
  active: "In progress",
  closing: "Ending",
  abandoned: "Abandoned",
  failed: "Failed",
  revoked: "Revoked",
};

/** Sessions list for one org and module (twin or role play), loaded by lib/pages/sessions.ts: filters in the URL, newest first. */
export function SessionsList({ data: { range, scenario, learner, scenarios, learners: learnerOptions, sessions, pageSize } }: { data: SessionsListData }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <PageContainer className="flex flex-col gap-8">
        <PageHeader
          icon={SessionsIcon}
          title="Sessions"
          actions={
            <SessionFilters
              scenarios={scenarios}
              learners={learnerOptions}
              scenario={scenario}
              learner={learner}
              range={range}
            />
          }
        />

        <section className="flex flex-col gap-3">
          <SectionHeader title="All sessions" note="Role play and twin conversations your learners had" />

          {sessions.length === 0 ? (
            <Empty className="rounded-2xl border bg-card">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SessionsIcon />
                </EmptyMedia>
                <EmptyTitle>No sessions found</EmptyTitle>
                <EmptyDescription>
                  {scenario !== "all" || learner !== "all" || range !== "all"
                    ? "Try a wider date range or clear the filters."
                    : "Sessions appear here once learners start practising."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-xs">
              {sessions.map((session) => {
                const name = session.user.name || session.user.email;
                const { ask, reply } = session;
                const status = STATUS_LABEL[session.status];
                const snippet = ask ? `“${ask}”${reply ? ` · ${reply}` : ""}` : reply;
                return (
                  <li key={session.id}>
                    <Link
                      href={`/sessions/${session.id}`}
                      className="group flex items-start gap-3.5 px-5 py-4 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
                    >
                      <UserAvatar user={session.user} size="lg" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{name}</span>
                        <span className="truncate text-[13px] text-muted-foreground">
                          {session.agent.name || session.agentSlug} ·{" "}
                          <SessionTime iso={(session.startedAt ?? session.createdAt).toISOString()} />
                          {status ? ` · ${status}` : ""}
                        </span>
                        {snippet ? (
                          <span className="truncate text-[13px] text-muted-foreground">{snippet}</span>
                        ) : null}
                      </span>
                      <ArrowUpRight
                        aria-hidden
                        className="mt-2.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {sessions.length === pageSize ? (
            <p className="text-center text-xs text-muted-foreground">Showing the latest {pageSize} sessions. Narrow the filters to see older ones.</p>
          ) : null}
        </section>
      </PageContainer>
    </div>
  );
}
