"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SessionTime } from "@/components/sessions/session-time";
import { useSessionReportState } from "@/components/twin/use-report-polling";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";

type SessionDetail = TwinOutputs["sessions"]["get"];

export function TwinSessionDetailPage({ session }: { session: SessionDetail }) {
  const duration = session.seconds === null ? null : `${Math.max(1, Math.round(session.seconds / 60))} min`;
  const report = useSessionReportState(session.id, session.reportState);

  return (
    <PageContainer>
      {/* Back navigation */}
      <header className="flex min-h-10 items-center justify-between gap-4">
        <Link
          href="/twin/sessions"
          className="inline-flex items-center gap-2 text-sm text-(--text-secondary) hover:text-(--foreground) transition-colors"
        >
          <ArrowLeft className="size-4" />
          <span>Twin sessions</span>
        </Link>
      </header>

      <div className="mt-6 flex flex-col gap-4">
        {/* Header Card (sr-head) */}
        <article className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
          <div className="flex items-center gap-4 min-w-0">
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-success-subtle text-base font-semibold text-success">
              {session.learner.charAt(0).toUpperCase()}
            </span>
            <div className="flex flex-col min-w-0">
              <h1 className="m-0 text-xl font-semibold leading-7">{session.learner}</h1>
              <p className="mt-0.5 text-sm font-medium text-(--foreground)">{session.agentName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <SessionTime iso={session.at} />
                {duration ? ` · ${duration}` : ""}
              </p>
            </div>
          </div>

          {/* Recording */}
          {session.hasVideo ? (
            <div className="flex flex-col gap-1.5 shrink-0 sm:w-60">
              <video
                src={`/api/sessions/${encodeURIComponent(session.id)}/video`}
                controls
                preload="metadata"
                className="w-full aspect-video rounded-tt-md bg-(--sidebar) object-cover"
              />
              <span className="text-overline text-muted-foreground text-center sm:text-left">
                Recording{duration ? ` · ${duration}` : ""}
              </span>
            </div>
          ) : null}
        </article>

        {/* Feedback Card: only when the learner left feedback */}
        {session.rating !== null || session.feedbackNote ? (
          <article className="rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
            <div className="flex items-center justify-between gap-4">
              <h2 className="m-0 text-sm font-semibold uppercase tracking-overline text-muted-foreground">
                Learner feedback
              </h2>
              {session.rating !== null ? (
                <span className="inline-flex items-center rounded-full bg-success-subtle px-3 py-1 text-xs font-semibold text-success">
                  Helpful {session.rating}/5
                </span>
              ) : null}
            </div>
            {session.feedbackNote ? <p className="mt-3 text-sm italic text-(--text-secondary)">“{session.feedbackNote}”</p> : null}
          </article>
        ) : null}

        {/* Topics Card: from the session report; quiet placeholders while it is made or when it isn't coming */}
        {report !== "ready" || session.topics.length ? (
          <article className="rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
            <h2 className="m-0 text-sm font-semibold uppercase tracking-overline text-muted-foreground">
              Topics discussed
            </h2>
            {report === "pending" ? (
              <div className="mt-3 flex flex-col gap-3" role="status" aria-live="polite">
                <div className="flex flex-wrap gap-2" aria-hidden>
                  {["w-28", "w-36", "w-24"].map((width) => (
                    <span key={width} className={cn("h-6 animate-pulse rounded-full bg-(--sidebar)", width)} />
                  ))}
                </div>
                <p className="m-0 text-xs text-muted-foreground">Preparing report…</p>
              </div>
            ) : report === "unavailable" ? (
              <p className="mt-3 text-sm text-muted-foreground">Report not available yet.</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {session.topics.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-(--sidebar) border border-(--border) px-3 py-1 text-xs font-medium text-(--text-secondary)"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </article>
        ) : null}

        {/* Transcript Card (rp-chat) */}
        <article className="rounded-tt-lg border border-(--card-border) bg-card p-6 shadow-card">
          <div className="flex items-center justify-between gap-4 border-b border-(--border) pb-4">
            <h2 className="m-0 text-base font-semibold">Transcript</h2>
          </div>

          <div className="mt-4 flex flex-col gap-4">
            {session.turns.length === 0 ? <p className="text-sm text-muted-foreground">No transcript was saved.</p> : null}
            {session.turns.map((turn, i) => {
              const isTwin = turn.who === "twin";
              return (
                <div
                  key={i}
                  className={cn(
                    "flex flex-col gap-1 max-w-[85%] rounded-xl p-4 text-sm leading-6",
                    isTwin
                      ? "self-start bg-(--sidebar) text-(--foreground)"
                      : "self-end bg-(--brand) text-white font-normal",
                  )}
                >
                  <span className={cn("text-xs font-semibold", isTwin ? "text-muted-foreground" : "text-white/80")}>
                    {isTwin ? session.agentName : session.learner}
                  </span>
                  <p className="m-0">{turn.text}</p>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </PageContainer>
  );
}
