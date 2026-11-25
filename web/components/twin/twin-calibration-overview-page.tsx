"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { SessionTime } from "@/components/sessions/session-time";
import { TwinFace } from "@/components/twin/twin-face";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

export function TwinCalibrationOverviewPage({ id, data }: { id: string; data: TwinOutputs["calibrations"]["list"] }) {
  const twinTitle = data.name;
  const calibrations = data.calibrations;
  // The twin's numbers are the coach's own calibrations; a team member's are tests (listed, not counted).
  const counted = calibrations.filter((c) => c.counts);

  // The twin's numbers: the coach's completed packs (each card's first answer); voice calls and team packs don't
  // count. Counts until enough packs make the score reliable, the accuracy after.
  const { score } = data;
  const teamTests = calibrations.length - counted.length;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[800px] px-4 md:px-0 pt-5 pb-10">
        {/* Header Back navigation */}
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link
            href={`/twin/${id}`}
            className="inline-flex items-center gap-2 text-sm text-(--foreground) hover:text-muted-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>{twinTitle}</span>
          </Link>
        </header>

        {/* Profile Card / Heading matching reference cal-who */}
        <div className="mt-6 flex flex-col items-center text-center">
          <TwinFace face={data.face} size="2xl" shape="rounded" />
          <h1 className="mt-3 text-xl font-semibold leading-7">{twinTitle}</h1>
        </div>

        {/* 3 stats: packs, answers marked off, accuracy */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <article className="flex flex-col justify-between rounded-tt-md border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-overline font-medium tracking-overline uppercase text-muted-foreground">Calibration packs</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{score.packsDone}</p>
            <p className={cn("m-0 mt-1 text-xs", score.reliable ? "text-success" : "text-muted-foreground")}>
              {score.reliable ? "✓ Reliable" : `of ${score.target} complete`}
              {teamTests > 0 ? <span className="text-muted-foreground">{` · ${teamTests} team ${teamTests === 1 ? "test" : "tests"}`}</span> : null}
            </p>
          </article>

          <article className="flex flex-col justify-between rounded-tt-md border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-overline font-medium tracking-overline uppercase text-muted-foreground">Feels off</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-caution">{score.answers - score.liked}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">responses</p>
          </article>

          <article className="flex flex-col justify-between rounded-tt-md border border-(--card-border) bg-card p-4 text-left shadow-xs">
            {score.reliable ? (
              <>
                <p className="m-0 text-overline font-medium tracking-overline uppercase text-muted-foreground">Accuracy</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{score.accuracy === null ? "—" : `${score.accuracy}%`}</p>
                <p className="m-0 mt-1 text-xs text-muted-foreground">Answers that felt like you</p>
              </>
            ) : (
              <>
                <p className="m-0 text-overline font-medium tracking-overline uppercase text-muted-foreground">Felt like you</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{score.answers ? `${score.liked} of ${score.answers}` : "—"}</p>
                <p className="m-0 mt-1 text-xs text-muted-foreground">Accuracy shows once your score is reliable</p>
              </>
            )}
          </article>
        </div>

        {/* Calibrations List section matching reference cal-list */}
        <div className="mt-10">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="m-0 text-section-title font-semibold leading-6 tracking-title">Calibrations</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your calibration packs</p>
            </div>
            <Link
              href={`/twin/${id}/calibrate`}
              className="inline-flex h-9 shrink-0 items-center rounded-full bg-(--brand) px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover outline-none focus-visible:ring-2 focus-visible:ring-(--brand) focus-visible:ring-offset-2"
            >
              Calibrate now
            </Link>
          </div>

          <div className="mt-4 flex flex-col overflow-hidden rounded-tt-lg border border-(--card-border) bg-card p-0 shadow-card">
            {calibrations.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No calibration packs yet. Calibrate to start your first.</p>
            ) : null}
            {calibrations.map((c, idx) => (
              <Link
                key={c.id}
                href={`/twin/${id}/calibration/${c.id}`}
                className={cn(
                  "flex items-center justify-between p-4 px-5 text-left transition-colors hover:bg-(--sidebar) outline-none focus-visible:bg-(--sidebar)",
                  idx > 0 && "border-t border-(--border)"
                )}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-semibold text-(--foreground)">{c.title}</span>
                  <span className="text-body-s text-muted-foreground">
                    <SessionTime iso={c.at} />
                    {c.seconds !== null ? ` · ${Math.max(1, Math.round(c.seconds / 60))} min` : ""}
                    {c.by ? ` · ${c.by}` : ""}
                    {c.counts ? "" : " · Team test, not counted"}
                  </span>
                </div>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
