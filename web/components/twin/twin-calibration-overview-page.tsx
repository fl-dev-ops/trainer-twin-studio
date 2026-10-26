"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Sliders } from "lucide-react";
import { cn } from "@/lib/utils";

const CALIBRATIONS = [
  {
    id: "cal-prices",
    title: "Handling “prices will drop next year”",
    when: "Today, 11:11",
    length: "6 min",
    turns: 15,
    like: 4,
    off: 1,
  },
  {
    id: "cal-fee",
    title: "Pushing back on a one percent fee",
    when: "Yesterday, 4:20",
    length: "5 min",
    turns: 4,
    like: 3,
    off: 0,
  },
  {
    id: "cal-landlord",
    title: "Opening a cold call with a landlord",
    when: "Mon, 10:05",
    length: "4 min",
    turns: 4,
    like: 3,
    off: 1,
  },
  {
    id: "cal-viewing",
    title: "Following up after a viewing",
    when: "Sun, 6:48",
    length: "2 min",
    turns: 3,
    like: 4,
    off: 0,
  },
];

export function TwinCalibrationOverviewPage({ id }: { id: string }) {
  const twinTitle = id === "olga-twin" ? "Olga’s twin" : "The off-plan sales process";

  const totalLike = CALIBRATIONS.reduce((acc, c) => acc + c.like, 0);
  const totalOff = CALIBRATIONS.reduce((acc, c) => acc + c.off, 0);
  const accuracy = Math.round((totalLike / (totalLike + totalOff)) * 100);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[800px] px-4 md:px-0 pt-5 pb-24">
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
          <div className="size-16 overflow-hidden rounded-[20px] bg-(--tone-control) shadow-sm">
            <video
              src="/media/twin-listening.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              className="size-full object-cover object-[center_18%]"
            />
          </div>
          <h1 className="mt-3 text-xl font-semibold leading-7">{twinTitle}</h1>
        </div>

        {/* 4 Stats Metrics matching reference cal-metrics--4 */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Total sessions</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{CALIBRATIONS.length}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">calibrations</p>
          </article>

          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Feels like me</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{totalLike}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">responses</p>
          </article>

          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Feels off</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">{totalOff}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">responses</p>
          </article>

          <article className="flex flex-col justify-between rounded-[12px] border border-(--card-border) bg-card p-4 text-left shadow-xs">
            <p className="m-0 text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Overall accuracy</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{accuracy}%</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">Rated “Feels like me”</p>
          </article>
        </div>

        {/* Calibrations List section matching reference cal-list */}
        <div className="mt-10">
          <h2 className="m-0 text-[18px] font-semibold leading-6 tracking-[-0.015em]">Calibrations</h2>
          <p className="mt-1 text-sm text-muted-foreground">Conversations you’ve had with this twin</p>

          <div className="mt-4 flex flex-col overflow-hidden rounded-[16px] border border-(--card-border) bg-card p-0 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            {CALIBRATIONS.map((c, idx) => (
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
                    {c.when} · {c.length} · {c.turns} turns
                  </span>
                </div>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </div>

        {/* Floating / Sticky Footer CTA matching reference cal-foot */}
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20">
          <Link
            href={`/calibration/${id}`}
            className="inline-flex h-11 items-center gap-2.5 rounded-full bg-(--brand) px-6 text-[14px] font-medium text-white shadow-lg transition-transform hover:scale-105 hover:bg-[#e04d00]"
          >
            <Sliders className="size-4" />
            <span>Calibrate now</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
