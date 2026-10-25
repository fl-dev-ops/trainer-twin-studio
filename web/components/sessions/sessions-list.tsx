import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SessionsIcon } from "@/components/icons";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { PageContainer } from "@/components/page-container";
import { SessionFilters } from "@/components/sessions/session-filters";
import { RANGE_OPTIONS } from "@/components/sessions/session-range";
import { SessionTime } from "@/components/sessions/session-time";
import { UserAvatar } from "@/components/user-avatar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { db } from "@/lib/db";
import { firstExchange } from "@/lib/session-snippet";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

const STATUS_LABEL: Record<string, string> = {
  assigned: "Not started",
  activating: "Starting",
  active: "In progress",
  closing: "Ending",
  abandoned: "Abandoned",
  failed: "Failed",
  revoked: "Revoked",
};


/** Start of the date-range filter, `days` back from now. */
const since = (days: number) => new Date(Date.now() - days * DAY_MS);

const pick = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export type SessionsSearchParams = Record<string, string | string[] | undefined>;

/** Sessions list for one org: filters in the URL, newest first. */
export async function SessionsList({ orgId, params }: { orgId: string; params: SessionsSearchParams }) {
  const range = RANGE_OPTIONS.some((o) => o.value === pick(params.range)) ? pick(params.range) : "30";
  const scenario = pick(params.scenario) || "all";
  const learner = pick(params.learner) || "all";

  const baseWhere = { orgId, deletedAt: null };
  const [sessions, scenarios, learners] = await Promise.all([
    db.interviewSession.findMany({
      where: {
        ...baseWhere,
        ...(scenario !== "all" ? { agentId: scenario } : {}),
        ...(learner !== "all" ? { userId: learner } : {}),
        ...(range !== "all" ? { createdAt: { gte: since(Number(range)) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        transcript: true,
        agentSlug: true,
        agent: { select: { name: true } },
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    }),
    db.agent.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.interviewSession.findMany({
      where: baseWhere,
      distinct: ["userId"],
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  const learnerOptions = learners
    .map(({ user }) => ({ value: user.id, label: user.name || user.email }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <PageContainer className="flex flex-col gap-8">
        <PageHeader
          icon={SessionsIcon}
          title="Sessions"
          actions={
            <SessionFilters
              scenarios={scenarios.map((a) => ({ value: a.id, label: a.name }))}
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
                const { ask, reply } = firstExchange(session.transcript);
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
          {sessions.length === PAGE_SIZE ? (
            <p className="text-center text-xs text-muted-foreground">Showing the latest {PAGE_SIZE} sessions. Narrow the filters to see older ones.</p>
          ) : null}
        </section>
      </PageContainer>
    </div>
  );
}
