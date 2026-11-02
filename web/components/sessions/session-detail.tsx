"use client";

import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, Play } from "lucide-react";
import { RECORDING_ID, SeekButton } from "@/components/sessions/seek-button";
import { SessionTime } from "@/components/sessions/session-time";
import { PageContainer } from "@/components/page-container";
import { UserAvatar } from "@/components/user-avatar";
import type { SessionDetailData } from "@/lib/pages/sessions";
import type { KeyMoment } from "@/lib/session-report";
import { cn } from "@/lib/utils";

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

/** Where a moment sits in the recording (seconds): only times taken from the transcript, never an older report's guess. */
const momentAt = (moment: KeyMoment) => (typeof moment.at === "number" && Number.isFinite(moment.at) ? moment.at : null);
const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function Card({ title, aside, children, className }: { title?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border bg-card px-6 py-5 shadow-elevation-1", className)}>
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

/** Session detail (V2 prototype), loaded by lib/pages/sessions.ts: who/when + recording, the AI evaluation, then the transcript. */
export function SessionDetail({ data: row }: { data: SessionDetailData }) {
  const { learner, trainer, scenario, hasVideo, minutes, report, reportState, transcript } = row;
  const status = STATUS_LABEL[row.status];

  return (
    <PageContainer className="flex flex-col gap-4">
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
            <UserAvatar user={row.user} size="md" />
            <h1 className="truncate text-lg font-semibold">{learner}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{scenario}</p>
          <p className="text-sm text-muted-foreground">
            <SessionTime iso={row.at.toISOString()} />
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
            <p className="text-body leading-6">{report.summary}</p>
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
                  const at = momentAt(moment);
                  const body = (
                    <>
                      <span className="flex items-center gap-2">
                        {at !== null ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
                            {hasVideo ? <Play className="size-3" aria-hidden /> : null}
                            {minutesSeconds(at)}
                          </span>
                        ) : null}
                        <span className="text-sm font-semibold">{moment.title}</span>
                      </span>
                      <span className="text-sm text-muted-foreground italic">“{moment.quote}”</span>
                      <span className="text-sm">{moment.description}</span>
                    </>
                  );
                  return (
                    <li key={moment.id ?? moment.number} className="py-3 first:pt-0 last:pb-0">
                      {hasVideo && at !== null ? (
                        <SeekButton
                          seconds={at}
                          className="-mx-2 flex w-[calc(100%+1.1rem)] flex-col gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
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
              <p className="text-body leading-6">{report.focusNextTime}</p>
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

      <section className="overflow-hidden rounded-2xl border bg-card shadow-elevation-1">
        <h2 className="px-6 py-5 text-base font-semibold">Transcript</h2>
        <div className="flex flex-col gap-3 bg-muted/50 px-6 py-5">
          {transcript.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transcript was captured.</p>
          ) : (
            transcript.map((turn, index) => {
              const isLearner = turn.role === "user";
              return (
                <div key={index} className={cn("flex", isLearner ? "justify-end" : "justify-start")}>
                  <div className="max-w-[78%] rounded-xl bg-card p-3 text-body leading-body shadow-elevation-1">
                    <p className="mb-0.5 text-body-s leading-body-s font-semibold">{isLearner ? learner : trainer}</p>
                    <p className="whitespace-pre-wrap">{turn.text}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </PageContainer>
  );
}
