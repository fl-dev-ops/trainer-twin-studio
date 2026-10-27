"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SessionTime } from "@/components/sessions/session-time";
import { minutesLabel, scoreTone } from "@/components/roleplay/roleplay-session-item";
import { UserAvatar } from "@/components/user-avatar";
import { roleplayClient } from "@/lib/roleplay/client";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

type Session = RoleplayOutputs["sessions"]["get"];

const card = "rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]";
const GOAL = {
  met: { label: "Met", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  partly: { label: "Partly", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  not_met: { label: "Missed", tone: "bg-(--tone-control) text-muted-foreground" },
} as const;

/** Quiet polling while the report is being made (as on twin sessions); the page refreshes when it lands. */
function useReportState(id: string, initial: Session["reportState"]) {
  const router = useRouter();
  const { data } = useQuery({
    queryKey: ["roleplay-report-state", id],
    queryFn: () => roleplayClient.sessions.reportState.query({ id }),
    enabled: initial === "pending",
    retry: false,
    refetchInterval: (query) => ((query.state.data?.state ?? "pending") === "pending" ? 3000 : false),
  });
  const state = initial === "pending" ? data?.state ?? "pending" : initial;
  useEffect(() => {
    if (initial === "pending" && state === "ready") router.refresh();
  }, [initial, state, router]);
  return state;
}

/** One practice session (reference pageSessionReport): who, rubric, goals, what went well / to work on, transcript. */
export function RoleplaySessionReportPage({ session }: { session: Session }) {
  const state = useReportState(session.id, session.reportState);
  const report = session.report;
  const rubric = report?.rubricScores ?? [];
  const earned = rubric.reduce((sum, row) => sum + row.points, 0);
  const total = rubric.reduce((sum, row) => sum + row.maxPoints, 0);
  const ratio = (row: (typeof rubric)[number]) => (row.maxPoints ? row.points / row.maxPoints : 0);
  const ranked = [...rubric].sort((a, b) => ratio(b) - ratio(a));
  const strong = ranked.slice(0, 2).filter((row) => ratio(row) >= 0.6);
  const growth = ranked.slice(-2).reverse().filter((row) => ratio(row) < 0.8);
  const length = minutesLabel(session.seconds);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[800px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center">
          <Link href={`/roleplay/${session.roleplay.slug}`} className="inline-flex items-center gap-2 text-sm text-(--foreground) transition-colors hover:text-muted-foreground">
            <ArrowLeft className="size-4" />
            <span>{session.roleplay.name}</span>
          </Link>
        </header>

        <div className="mt-6 flex flex-col gap-4">
          <article className={cn(card, "flex flex-wrap items-start justify-between gap-4")}>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-3">
                <UserAvatar user={{ name: session.learner.name, image: session.learner.image }} className="size-10 text-sm" />
                <h1 className="m-0 truncate text-[20px] leading-7 font-semibold tracking-[-0.015em]">{session.learner.name}</h1>
              </div>
              <p className="m-0 mt-1 text-sm text-muted-foreground">{session.roleplay.name}</p>
              <p className="m-0 text-sm text-muted-foreground">
                <SessionTime iso={session.at} />
                {length ? ` · ${length}` : ""}
              </p>
              <p className="m-0 mt-2 flex items-center gap-2 text-sm">
                <UserAvatar user={{ name: session.client.name, image: session.client.photoUrl }} className="size-6 text-[10px]" />
                <span>
                  Spoke with <b>{session.client.name}</b>
                </span>
              </p>
            </div>
            {report?.score !== undefined ? (
              <span className={cn("rounded-full px-3 py-1 text-sm font-semibold tabular-nums", scoreTone(report.score))}>
                {report.score} / 100 · {report.score >= 70 ? "Pass" : "Not yet"}
              </span>
            ) : null}
          </article>

          {!report ? (
            <article className={card}>
              <p className="m-0 text-sm text-muted-foreground" role="status">
                {state === "pending" ? "Preparing report…" : "No report for this session."}
              </p>
            </article>
          ) : (
            <>
              {report.summary ? (
                <article className={card}>
                  <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Summary</h2>
                  <p className="m-0 mt-2 text-[15px] leading-6 text-(--text-secondary)">{report.summary}</p>
                  {report.focusNextTime ? (
                    <p className="m-0 mt-3 rounded-[12px] bg-(--sidebar) p-3 text-sm">
                      <b>Biggest opportunity:</b> {report.focusNextTime}
                    </p>
                  ) : null}
                </article>
              ) : null}

              {rubric.length ? (
                <article className={card}>
                  <div className="flex items-baseline justify-between gap-4">
                    <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Scoring rubric</h2>
                    <p className="m-0 text-sm tabular-nums">
                      <b>{earned}</b> / {total}
                    </p>
                  </div>
                  <ul className="m-0 mt-4 flex list-none flex-col gap-3 p-0">
                    {rubric.map((row) => (
                      <li key={row.criterion} className="grid grid-cols-[minmax(0,1fr)_120px_56px] items-center gap-3 text-sm" title={row.reason}>
                        <span className="truncate">{row.criterion}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-(--tone-control)" aria-hidden>
                          <span className="block h-full rounded-full bg-(--foreground)" style={{ width: `${Math.round(ratio(row) * 100)}%` }} />
                        </span>
                        <span className="text-right text-muted-foreground tabular-nums">
                          {row.points} / {row.maxPoints}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              ) : null}

              {report.goalResults?.length ? (
                <article className={card}>
                  <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Learner goals</h2>
                  <ul className="m-0 mt-3 flex list-none flex-col p-0">
                    {report.goalResults.map((goal, i) => (
                      <li key={goal.goal} className={cn("flex items-start justify-between gap-4 py-3", i > 0 && "border-t border-(--border)")}>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm">{goal.goal}</span>
                          {goal.evidence ? <span className="text-xs text-muted-foreground">{goal.evidence}</span> : null}
                        </span>
                        <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", GOAL[goal.status].tone)}>{GOAL[goal.status].label}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ) : null}

              {strong.length || growth.length ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {[{ title: "What went well", rows: strong, tone: "text-emerald-700 dark:text-emerald-300" }, { title: "To work on", rows: growth, tone: "text-amber-700 dark:text-amber-300" }].map((group) => (
                    <article key={group.title} className={card}>
                      <h2 className={cn("m-0 text-[15px] font-semibold", group.tone)}>{group.title}</h2>
                      {group.rows.length ? (
                        <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
                          {group.rows.map((row) => (
                            <li key={row.criterion}>
                              <p className="m-0 text-sm font-medium">
                                {row.criterion} · {row.points} / {row.maxPoints}
                              </p>
                              {row.reason ? <p className="m-0 mt-0.5 text-sm text-muted-foreground">{row.reason}</p> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="m-0 mt-3 text-sm text-muted-foreground">Nothing stood out.</p>
                      )}
                    </article>
                  ))}
                </div>
              ) : null}
            </>
          )}

          <article className={card}>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Transcript</h2>
            {session.turns.length ? (
              <div className="mt-4 flex flex-col gap-4">
                {session.turns.map((turn, i) => (
                  <div key={i} className={cn("flex flex-col gap-1", turn.who === "learner" && "items-end")}>
                    <span className="text-xs text-muted-foreground">{turn.who === "learner" ? session.learner.name : session.client.name}</span>
                    <p className={cn("m-0 max-w-[85%] rounded-[16px] px-3.5 py-2 text-sm leading-5 whitespace-pre-wrap", turn.who === "learner" ? "bg-(--brand)/10" : "bg-(--sidebar)")}>
                      {turn.text}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No transcript was saved.</p>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}
