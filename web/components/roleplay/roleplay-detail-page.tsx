"use client";

import Link from "next/link";
import { ArrowLeft, Pencil } from "lucide-react";
import { SessionTime } from "@/components/sessions/session-time";
import { RoleplayMenu } from "@/components/roleplay/roleplay-library-page";
import { RoleplaySessionItem } from "@/components/roleplay/roleplay-session-item";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

type Detail = RoleplayOutputs["scenarios"]["get"];

const card = "flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";
const kicker = "text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground";

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Invited", tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  used: { label: "Practised", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  expired: { label: "Expired", tone: "bg-(--tone-control) text-muted-foreground" },
  cancelled: { label: "Cancelled", tone: "bg-(--tone-control) text-muted-foreground" },
};

/** One role play (reference roleDetail): client and scenario, report stats, members, sessions. */
export function RoleplayDetailPage({ roleplay }: { roleplay: Detail }) {
  const { stats } = roleplay;
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link href="/roleplay" className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
            <ArrowLeft className="size-4" />
            <span>Back</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href={`/roleplay/${roleplay.slug}/edit`}
              className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#e04d00] dark:hover:bg-[#ff7e33]"
            >
              <Pencil className="size-3.5" />
              <span>Edit</span>
            </Link>
            <RoleplayMenu slug={roleplay.slug} name={roleplay.name} trigger="header" />
          </div>
        </header>

        <div className="mt-6 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
          <article className={card}>
            <h1 className="m-0 line-clamp-2 text-[18px] leading-7 font-semibold tracking-[-0.015em]" title={roleplay.name}>
              {roleplay.name}
            </h1>
            <div className="mt-6">
              <p className={kicker}>Client persona</p>
              <p className="mt-2 flex items-center gap-3 text-[17px] font-semibold">
                <UserAvatar user={{ name: roleplay.client.name, image: roleplay.client.photoUrl }} className="size-10 text-sm" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{roleplay.client.name}</span>
                  {roleplay.client.role ? <span className="text-xs font-normal text-muted-foreground">{roleplay.client.role}</span> : null}
                </span>
              </p>
            </div>
            <div className="mt-6">
              <p className={kicker}>Scenario</p>
              <p className="mt-1 line-clamp-6 text-[15px] leading-6 text-(--text-secondary)" title={roleplay.situation ?? undefined}>
                {roleplay.situation ?? roleplay.description ?? "No scenario yet."}
              </p>
            </div>
            {roleplay.learnerRole ? (
              <div className="mt-6">
                <p className={kicker}>Learner plays</p>
                <p className="mt-1 text-[15px] leading-6">{roleplay.learnerRole}</p>
              </div>
            ) : null}
          </article>

          <article className={card}>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Report</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-[12px] bg-emerald-500/10 p-4 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Sessions</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{stats.sessions}</p>
              </div>
              <div className="rounded-[12px] bg-amber-500/10 p-4 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Avg score</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {stats.averageScore ?? "—"} {stats.averageScore !== null ? <span className="text-sm font-normal opacity-70">/ 100</span> : null}
                </p>
              </div>
              <div className="rounded-[12px] bg-sky-500/10 p-4 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Difficulty</p>
                <p className="mt-2 text-2xl font-semibold capitalize">{roleplay.difficulty ?? "—"}</p>
              </div>
              <div className="rounded-[12px] bg-(--sidebar) p-4 text-(--foreground)">
                <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Avg session length</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {stats.averageMinutes ?? "—"} {stats.averageMinutes !== null ? <span className="text-sm font-normal text-muted-foreground">min</span> : null}
                </p>
              </div>
            </div>
          </article>

          <article className={cn(card, "md:col-span-2")}>
            <div className="flex items-center justify-between gap-4">
              <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Members</h2>
              <Link href={`/roleplay/${roleplay.slug}/assign`} className="text-sm font-medium text-(--brand) hover:underline">
                Assign
              </Link>
            </div>
            {roleplay.members.length ? (
              <ul className="m-0 mt-2 flex list-none flex-col p-0">
                {roleplay.members.map((member, i) => (
                  <li key={member.id} className={cn("flex items-center justify-between gap-3 py-3", i > 0 && "border-t border-(--border)")}>
                    <span className="flex min-w-0 items-center gap-3">
                      <UserAvatar user={{ name: member.name, image: member.image }} className="size-8 text-xs" />
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
            <h2 className="m-0 px-6 pt-6 text-[17px] font-semibold tracking-[-0.015em]">Sessions</h2>
            <ul className="m-0 mt-2 flex list-none flex-col p-0 pb-2">
              {roleplay.sessions.length === 0 ? <li className="px-6 py-3.5 text-sm text-muted-foreground">No sessions yet.</li> : null}
              {roleplay.sessions.map((session, i) => (
                <RoleplaySessionItem key={session.id} session={session} index={i} divider={i > 0} />
              ))}
            </ul>
          </article>
        </div>
      </div>
    </div>
  );
}
