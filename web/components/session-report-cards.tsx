import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GoalResult, SessionReport } from "@/lib/session-report";
import { cn } from "@/lib/utils";

const GOAL_LABEL: Record<GoalResult["status"], string> = { met: "Met", partly: "Partly", not_met: "Not met" };

/** A completed session report: summary and topics, rubric scores, learner goals and next focus. */
export function SessionReportCards({ report }: { report: SessionReport }) {
  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle>Summary</CardTitle>
          {typeof report.score === "number" && !report.rubricScores?.length ? (
            <p className="text-sm tabular-nums"><span className="text-lg font-semibold">{Math.round(report.score)}</span> / 100</p>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-6">{report.summary}</p>
          {report.summaryTags.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Topics discussed</p>
              <div className="flex flex-wrap gap-2">
                {report.summaryTags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {report.rubricScores?.length ? (
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle>Scoring rubric</CardTitle>
            <p className="text-sm tabular-nums"><span className="text-lg font-semibold">{report.score ?? 0}</span> / 100</p>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {report.rubricScores.map((row) => (
                <li key={row.criterion} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 text-sm">{row.criterion}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${row.maxPoints ? Math.round((row.points / row.maxPoints) * 100) : 0}%` }}
                        />
                      </span>
                      <span className="w-14 text-right text-sm tabular-nums">{row.points} / {row.maxPoints}</span>
                    </span>
                  </div>
                  {row.reason && <p className="text-xs leading-5 text-muted-foreground">{row.reason}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {report.goalResults?.length ? (
        <Card>
          <CardHeader><CardTitle>Learner goals</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {report.goalResults.map((row) => (
                <li key={row.goal} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 text-sm">{row.goal}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium",
                        row.status === "met" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
                        row.status === "partly" && "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
                        row.status === "not_met" && "bg-muted text-muted-foreground",
                      )}
                    >
                      {GOAL_LABEL[row.status]}
                    </span>
                  </div>
                  {row.evidence && <p className="text-xs leading-5 text-muted-foreground">{row.evidence}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {report.focusNextTime && (
        <Card>
          <CardHeader><CardTitle>Focus next time</CardTitle></CardHeader>
          <CardContent><p className="text-sm leading-6">{report.focusNextTime}</p></CardContent>
        </Card>
      )}
    </>
  );
}
