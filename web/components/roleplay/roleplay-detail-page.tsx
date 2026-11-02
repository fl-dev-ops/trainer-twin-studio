"use client";

import Link from "next/link";
import { ArrowLeft, Pencil } from "lucide-react";
import { SessionTime } from "@/components/sessions/session-time";
import { RoleplayMenu } from "@/components/roleplay/roleplay-library-page";
import { RoleplaySessionItem } from "@/components/roleplay/roleplay-session-item";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";

type Detail = RoleplayOutputs["scenarios"]["get"];

const card = "flex flex-col rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card";
const kicker = "text-overline font-medium tracking-overline uppercase text-muted-foreground";

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Invited", tone: "bg-info-subtle text-info" },
  used: { label: "Practised", tone: "bg-success-subtle text-success" },
  expired: { label: "Expired", tone: "bg-(--tone-control) text-muted-foreground" },
  cancelled: { label: "Cancelled", tone: "bg-(--tone-control) text-muted-foreground" },
};

/** One role play (reference roleDetail): client and scenario, report stats, members, sessions. */
export function RoleplayDetailPage({ roleplay }: { roleplay: Detail }) {
  const { stats } = roleplay;
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link href="/roleplay" className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href={`/roleplay/${roleplay.slug}/edit`}
            className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-4 text-body-s font-medium text-white transition-colors hover:bg-brand-hover"
          >
            <Pencil className="size-3.5" />
            <span>Edit</span>
          </Link>
          <RoleplayMenu slug={roleplay.slug} name={roleplay.name} trigger="header" />
        </div>
      </header>

      <div className="mt-6 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        <article className={card}>
          <h1 className="m-0 line-clamp-2 text-section-title leading-7 font-semibold tracking-title" title={roleplay.name}>
            {roleplay.name}
          </h1>
          <div className="mt-6">
            <p className={kicker}>Client persona</p>
            <p className="mt-2 flex items-center gap-3 text-title-s font-semibold">
              <UserAvatar user={{ name: roleplay.client.name, image: roleplay.client.photoUrl }} size="xl" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{roleplay.client.name}</span>
                {roleplay.client.role ? <span className="text-xs font-normal text-muted-foreground">{roleplay.client.role}</span> : null}
              </span>
            </p>
          </div>
          <div className="mt-6">
            <p className={kicker}>Scenario</p>
            <p className="mt-1 line-clamp-6 text-body leading-6 text-(--text-secondary)" title={roleplay.situation ?? undefined}>
              {roleplay.situation ?? roleplay.description ?? "No scenario yet."}
            </p>
          </div>
          {roleplay.learnerRole ? (
            <div className="mt-6">
              <p className={kicker}>Learner plays</p>
              <p className="mt-1 text-body leading-6">{roleplay.learnerRole}</p>
            </div>
          ) : null}
        </article>

        <article className={card}>
          <h2 className="m-0 text-title-s font-semibold tracking-title">Report</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-tt-md bg-success-subtle p-4 text-success">
              <p className="text-overline font-medium tracking-overline uppercase">Sessions</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{stats.sessions}</p>
            </div>
            <div className="rounded-tt-md bg-caution-subtle p-4 text-caution">
              <p className="text-overline font-medium tracking-overline uppercase">Avg score</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {stats.averageScore ?? "—"} {stats.averageScore !== null ? <span className="text-sm font-normal opacity-70">/ 100</span> : null}
              </p>
            </div>
            <div className="rounded-tt-md bg-info-subtle p-4 text-info">
              <p className="text-overline font-medium tracking-overline uppercase">Difficulty</p>
              <p className="mt-2 text-2xl font-semibold capitalize">{roleplay.difficulty ?? "—"}</p>
            </div>
            <div className="rounded-tt-md bg-(--sidebar) p-4 text-(--foreground)">
              <p className="text-overline font-medium tracking-overline text-muted-foreground uppercase">Avg session length</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {stats.averageMinutes ?? "—"} {stats.averageMinutes !== null ? <span className="text-sm font-normal text-muted-foreground">min</span> : null}
              </p>
            </div>
          </div>
        </article>

        <article className={cn(card, "md:col-span-2")}>
          <div className="flex items-center justify-between gap-4">
            <h2 className="m-0 text-title-s font-semibold tracking-title">Members</h2>
            <Link href={`/roleplay/${roleplay.slug}/assign`} className="text-sm font-medium text-(--brand) hover:underline">
              Assign
            </Link>
          </div>
          {roleplay.members.length ? (
            <ul className="m-0 mt-2 flex list-none flex-col p-0">
              {roleplay.members.map((member, i) => (
                <li key={member.id} className={cn("flex items-center justify-between gap-3 py-3", i > 0 && "border-t border-(--border)")}>
                  <span className="flex min-w-0 items-center gap-3">
                    <UserAvatar user={{ name: member.name, image: member.image }} size="md" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{member.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {member.email} · invited <SessionTime iso={member.assignedAt} />
                      </span>
                    </span>
                  </span>
                  <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", (STATUS[member.status] ?? STATUS.pending).tone)}>
                    {(STATUS[member.status] ?? STATUS.pending).label}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Nobody is assigned yet.</p>
          )}
        </article>

        <article className={cn(card, "p-0 md:col-span-2")}>
          <h2 className="m-0 px-6 pt-6 text-title-s font-semibold tracking-title">Sessions</h2>
          <ul className="m-0 mt-2 flex list-none flex-col p-0 pb-2">
            {roleplay.sessions.length === 0 ? <li className="px-6 py-3.5 text-sm text-muted-foreground">No sessions yet.</li> : null}
            {roleplay.sessions.map((session, i) => (
              <RoleplaySessionItem key={session.id} session={session} divider={i > 0} />
            ))}
          </ul>
        </article>
      </div>
    </PageContainer>
  );
}
