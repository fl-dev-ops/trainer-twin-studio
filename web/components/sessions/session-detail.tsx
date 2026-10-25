import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, ArrowLeft, Loader2, Play } from "lucide-react";
import { RECORDING_ID, SeekButton } from "@/components/sessions/seek-button";
import { SessionTime } from "@/components/sessions/session-time";
import { db } from "@/lib/db";
import { isSessionReport, normalizeSessionReportStatus, type KeyMoment } from "@/lib/session-report";
import { cn } from "@/lib/utils";

type Turn = { role?: string; text?: string };

const STATUS_LABEL: Record<string, string> = {
  assigned: "Not started",
  activating: "Starting",
  active: "In progress",
  closing: "Ending",
  abandoned: "Abandoned",
  failed: "Failed",
  revoked: "Revoked",
};

const REPORT_STATUS = {
  generating: { title: "Evaluation in progress", body: "The session was saved. Feedback is still being generated.", icon: Loader2 },
  failed: { title: "Evaluation failed", body: "The session was saved, but feedback could not be generated.", icon: AlertCircle },
  none: { title: "No evaluation", body: "This session ended before an evaluation could start.", icon: AlertCircle },
} as const;

/** "2:18" → 138; prefers the model's explicit seconds when present. */
function momentSeconds(moment: KeyMoment) {
  if (typeof moment.seconds === "number" && Number.isFinite(moment.seconds)) return Math.max(0, moment.seconds);
  const [m, s] = moment.timestamp.split(":").map(Number);
  return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : 0;
}

function Card({ title, aside, children, className }: { title?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border bg-card px-6 py-5 shadow-[0_1px_2px_rgba(30,28,25,0.04)]", className)}>
      {title ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const chip = "rounded-full bg-muted px-3.5 py-1 text-sm font-medium text-muted-foreground";

/** Session detail (V2 prototype): who/when + recording, the AI evaluation, then the transcript. */
export async function SessionDetail({ orgId, id }: { orgId: string; id: string }) {
  const row = await db.interviewSession.findFirst({
    where: { id, orgId, deletedAt: null },
    select: {
      id: true,
      status: true,
      agentId: true,
      agentSlug: true,
      createdAt: true,
      startedAt: true,
      endedAt: true,
      transcript: true,
      evidence: true,
      videoEgressId: true,
      report: true,
      reportStatus: true,
      agent: { select: { name: true, persona: { select: { name: true } } } },
      user: { select: { name: true, email: true } },
    },
  });
  if (!row) notFound();

  const learner = row.user.name || row.user.email;
  const trainer = row.agent.persona.name || "Trainer";
  const scenario = row.agent.name || row.agentSlug;
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;
  const hasVideo = Boolean(row.videoEgressId || evidence.videoS3Key || evidence.videoUrl);
  const minutes =
    row.startedAt && row.endedAt ? Math.max(1, Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 60_000)) : null;
  const status = STATUS_LABEL[row.status];
  const report = isSessionReport(row.report) ? row.report : null;
  const reportState = normalizeSessionReportStatus(row.reportStatus, Boolean(report));
  const transcript = ((Array.isArray(row.transcript) ? row.transcript : []) as Turn[]).filter((t) => t.text?.trim());

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Link
          href={`/sessions?scenario=${encodeURIComponent(row.agentId)}&range=all`}
          className="mb-2 flex w-fit items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {scenario}
        </Link>

        {/* Who and when, with the recording beside it. */}
        <Card className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-100 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              >
                {learner.charAt(0).toUpperCase()}
              </span>
              <h1 className="truncate text-lg font-semibold">{learner}</h1>
            </div>
            <p className="text-sm text-muted-foreground">{scenario}</p>
            <p className="text-sm text-muted-foreground">
              <SessionTime iso={(row.startedAt ?? row.createdAt).toISOString()} />
              {minutes ? ` · ${minutes} min` : ""}
              {status ? ` · ${status}` : ""}
            </p>
          </div>
          {hasVideo ? (
            <figure className="flex shrink-0 flex-col gap-1.5">
              <video
                id={RECORDING_ID}
                controls
                preload="metadata"
                playsInline
                src={`/api/sessions/${row.id}/video`}
                className="aspect-video w-full rounded-xl bg-muted object-contain sm:w-[240px]"
              />
              <figcaption className="text-xs text-muted-foreground">Recording{minutes ? ` · ${minutes} min` : ""}</figcaption>
            </figure>
          ) : null}
        </Card>

        {report ? (
          <>
            <Card
              title="Summary"
              aside={
                typeof report.score === "number" ? (
                  <span className="rounded-full bg-muted px-3 py-1 text-sm font-medium">
                    {Math.round(report.score)}
                    <span className="text-muted-foreground"> / 100</span>
                  </span>
                ) : null
              }
            >
              <p className="text-[15px] leading-6">{report.summary}</p>
              {report.summaryTags.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {report.summaryTags.map((tag) => (
                    <span key={tag} className={chip}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </Card>

            {report.keyMoments.length ? (
              <Card title="Key moments">
                <ol className="flex flex-col divide-y">
                  {report.keyMoments.map((moment) => {
                    const body = (
                      <>
                        <span className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
                            {hasVideo ? <Play className="size-3" aria-hidden /> : null}
                            {moment.timestamp}
                          </span>
                          <span className="text-sm font-semibold">{moment.title}</span>
                        </span>
                        <span className="text-sm text-muted-foreground italic">“{moment.quote}”</span>
                        <span className="text-sm">{moment.description}</span>
                      </>
                    );
                    return (
                      <li key={moment.id ?? moment.number} className="py-3 first:pt-0 last:pb-0">
                        {hasVideo ? (
                          <SeekButton
                            seconds={momentSeconds(moment)}
                            className="-mx-2 flex w-[calc(100%+1rem)] flex-col gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
                          >
                            {body}
                          </SeekButton>
                        ) : (
                          <div className="flex flex-col gap-1.5">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </Card>
            ) : null}

            {report.focusNextTime ? (
              <Card title="Focus next time">
                <p className="text-[15px] leading-6">{report.focusNextTime}</p>
              </Card>
            ) : null}
          </>
        ) : reportState !== "completed" ? (
          (() => {
            const copy = REPORT_STATUS[reportState];
            return (
              <Card>
                <div className="flex items-start gap-3">
                  <copy.icon
                    className={cn("mt-0.5 size-5 text-muted-foreground", reportState === "generating" && "animate-spin")}
                    aria-hidden
                  />
                  <div>
                    <h2 className="text-sm font-semibold">{copy.title}</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">{copy.body}</p>
                  </div>
                </div>
              </Card>
            );
          })()
        ) : null}

        <section className="overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgba(30,28,25,0.04)]">
          <h2 className="px-6 py-5 text-base font-semibold">Transcript</h2>
          <div className="flex flex-col gap-3 bg-muted/50 px-6 py-5">
            {transcript.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transcript was captured.</p>
            ) : (
              transcript.map((turn, index) => {
                const isLearner = turn.role === "user";
                return (
                  <div key={index} className={cn("flex", isLearner ? "justify-end" : "justify-start")}>
                    <div className="max-w-[78%] rounded-xl bg-card p-3 text-[15px] leading-[23px] shadow-[0_1px_2px_rgba(30,28,25,0.06)]">
                      <p className="mb-0.5 text-[13px] leading-[18px] font-semibold">{isLearner ? learner : trainer}</p>
                      <p className="whitespace-pre-wrap">{turn.text}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
