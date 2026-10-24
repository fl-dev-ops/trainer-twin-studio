import type { ReactNode } from "react";
import { BackButton } from "@/components/roleplay/back-button";
import { LearnerAvatar } from "@/components/roleplay/learner-avatar";
import { SessionWhen } from "@/components/roleplay/session-when";
import type { RoleplaySessionReportData } from "@/lib/roleplay-sessions";
import type { GoalResult } from "@/lib/session-report";
import { cn } from "@/lib/utils";

const GOAL_CHIP: Record<GoalResult["status"], { label: string; className: string }> = {
  met: { label: "Met", className: "bg-[#edf9f1] text-[#1a6739]" },
  partly: { label: "Partly", className: "bg-[#fdf6e3] text-[#7f5f00]" },
  not_met: { label: "Missed", className: "bg-muted text-muted-foreground" },
};

function Card({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <article className={cn("rounded-2xl border bg-card p-6 shadow-xs", className)}>
      {title ? (
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </article>
  );
}

/** One practice session: who, the recording, the rubric, the learner goals and the call itself. */
export function RoleplaySessionReport({ data }: { data: RoleplaySessionReportData }) {
  const report = data.report;
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 pt-5 sm:px-8">
        <BackButton label={data.title} fallback="/sessions" />
      </div>
      <div className="mx-auto flex max-w-[656px] flex-col gap-4 px-4 pt-12 pb-12">
        <Card className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <LearnerAvatar name={data.learner} index={0} className="size-7 text-sm" />
              <h1 className="text-lg font-semibold">{data.learner}</h1>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{data.title}</p>
            <p className="text-sm text-muted-foreground"><SessionWhen iso={data.at} />{data.minutes ? ` · ${data.minutes} min` : ""}</p>
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              {data.clientAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element -- persona photos are static or uploaded URLs
                <img src={data.clientAvatar} alt="" className="size-6 rounded-full object-cover" />
              ) : null}
              <span>Spoke with <b className="font-medium text-foreground">{data.client}</b></span>
            </p>
          </div>
          {data.hasVideo ? (
            <figure className="flex w-60 flex-col gap-1.5">
              <video controls preload="metadata" playsInline src={`/api/sessions/${data.id}/video`}
                aria-label="Recording of this session" className="aspect-video w-full rounded-xl bg-black object-cover" />
              <figcaption className="text-xs text-muted-foreground">Recording{data.minutes ? ` · ${data.minutes} min` : ""}</figcaption>
            </figure>
          ) : null}
        </Card>

        {!report ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              {data.reportStatus === "generating" ? "The report is being written. Check back in a minute." : "No report for this session yet."}
            </p>
          </Card>
        ) : null}

        {report?.rubricScores?.length ? (
          <Card title="Scoring rubric" aside={<p className="text-sm text-muted-foreground tabular-nums"><b className="text-lg font-semibold text-foreground">{report.score ?? 0}</b> / 100</p>}>
            <ul className="divide-y">
              {report.rubricScores.map((row) => (
                <li key={row.criterion} className="flex items-center gap-4 py-3 text-sm first:pt-0 last:pb-0" title={row.reason || undefined}>
                  <span className="min-w-0 flex-1">{row.criterion}</span>
                  <span className="h-1.5 w-[120px] shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-primary"
                      style={{ width: `${row.maxPoints ? Math.round((row.points / row.maxPoints) * 100) : 0}%` }} />
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums">{row.points} / {row.maxPoints}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {report?.goalResults?.length ? (
          <Card title="Learner goals">
            <ul className="divide-y">
              {report.goalResults.map((goal) => (
                <li key={goal.goal} className="flex items-center justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0" title={goal.evidence || undefined}>
                  <span className="min-w-0">{goal.goal}</span>
                  <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", GOAL_CHIP[goal.status].className)}>
                    {GOAL_CHIP[goal.status].label}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <article className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <h2 className="px-6 pt-6 pb-4 text-base font-semibold">Transcript</h2>
          <div className="flex flex-col gap-3 bg-muted/70 p-6">
            {data.turns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transcript was captured.</p>
            ) : data.turns.map((turn, index) => (
              <div key={index}
                className={cn("max-w-[78%] rounded-xl bg-card px-3 py-2.5 text-sm shadow-xs", turn.who === "learner" && "self-end")}>
                <b className="block font-semibold">{turn.who === "learner" ? data.learner : data.client}</b>
                <p className="leading-6">{turn.text}</p>
              </div>
            ))}
          </div>
        </article>
      </div>
    </main>
  );
}
