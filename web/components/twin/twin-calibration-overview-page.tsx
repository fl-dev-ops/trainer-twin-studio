"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { SessionTime } from "@/components/sessions/session-time";
import { TwinFace } from "@/components/twin/twin-face";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { accuracyOf } from "@/lib/twin/stats";
import { cn } from "@/lib/utils";

export function TwinCalibrationOverviewPage({ id, data }: { id: string; data: TwinOutputs["calibrations"]["list"] }) {
  const twinTitle = data.name;
  const calibrations = data.calibrations;

  // Jev's counts per calibration (raw until scored): the trainer's real turns, and the "Feels off" they meant.
  const totalTurns = calibrations.reduce((acc, c) => acc + c.turns, 0);
  const totalOff = calibrations.reduce((acc, c) => acc + c.off, 0);
  const overall = accuracyOf({ turns: totalTurns, off: totalOff });
  const accuracy = overall === null ? "—" : `${overall}%`;

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
          <TwinFace face={data.face} className="size-16 text-2xl rounded-[20px] shadow-sm after:rounded-[20px] *:rounded-[20px]" />
          <h1 className="mt-3 text-xl font-semibold leading-7">{twinTitle}</h1>
        </div>

        {/* 4 Stats Metrics matching reference cal-metrics--4 */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Total sessions</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{calibrations.length}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">calibrations</p>
          </article>

          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Turns</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{totalTurns}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">your turns</p>
          </article>

          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Feels off</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">{totalOff}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">responses</p>
          </article>

          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Overall accuracy</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{accuracy}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">Turns that felt like you</p>
          </article>
        </div>

        {/* Calibrations List section matching reference cal-list */}
        <div className="mt-10">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="m-0 text-[18px] font-semibold leading-6 tracking-[-0.015em]">Calibrations</h2>
              <p className="mt-1 text-sm text-muted-foreground">Conversations you’ve had with this twin</p>
            </div>
            <Link
              href={`/twin/${id}/calibrate`}
              className="inline-flex h-9 shrink-0 items-center rounded-full bg-(--brand) px-4 text-sm font-medium text-white transition-colors hover:bg-[#e04d00] outline-none focus-visible:ring-2 focus-visible:ring-(--brand) focus-visible:ring-offset-2"
            >
              Calibrate now
            </Link>
          </div>

          <div className="mt-4 flex flex-col overflow-hidden rounded-[16px] border border-(--card-border) bg-card p-0 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            {calibrations.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No calibrations yet. Talk to your twin and rate its answers.</p>
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
                  <span className="text-[13px] text-muted-foreground">
                    <SessionTime iso={c.at} />
                    {c.seconds !== null ? ` · ${Math.max(1, Math.round(c.seconds / 60))} min` : ""} · {c.turns} turns
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
