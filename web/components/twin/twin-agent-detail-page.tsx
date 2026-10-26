"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Play,
  Settings2,
  Share2,
  Sliders,
  Trash2,
  UserPlus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SessionTime } from "@/components/sessions/session-time";
import { copyTwinLink } from "@/components/twin/copy-twin-link";
import { TwinSessionItem } from "@/components/twin/twin-session-item";
import { usePendingReports } from "@/components/twin/use-report-polling";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

type TwinDetail = TwinOutputs["agents"]["get"];

const DAY = 86_400_000;
/** Whether an ISO time falls in the picked range ("30", "7", "today" or "all"). */
function inRange(iso: string, range: string, now = Date.now()) {
  if (range === "all") return true;
  const at = new Date(iso).getTime();
  if (range === "today") return new Date(at).toDateString() === new Date(now).toDateString();
  return at >= now - Number(range) * DAY;
}
const minutesLabel = (seconds: number | null) => (seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min`);

const DATE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "7", label: "Last 7 days" },
  { value: "today", label: "Today" },
  { value: "all", label: "All time" },
];

function MoreDotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden>
      <circle cx="8" cy="3.25" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="12.75" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** 7-bar chart matching beta roleBars() */
function WeekBarsChart({ days }: { days: TwinDetail["report"]["week"] }) {
  const top = Math.max(1, ...days.map((day) => day.value));
  // Bars scale to the busiest day (58px); an empty day keeps a 2px stub so the week still reads.
  const bars = days.map((day) => ({ ...day, h: Math.max(2, Math.round((day.value / top) * 58)) }));

  return (
    <div className="w-full">
      <p className="m-0 mb-3 text-[13px] font-medium text-muted-foreground">Conversations, last 7 days</p>
      <svg viewBox="0 0 720 96" className="w-full h-auto max-h-[96px] overflow-visible" role="img" aria-label="Sessions this week">
        {bars.map((item, i) => {
          const width = 720;
          const pad = 4;
          const gap = 18;
          const barW = (width - pad * 2 - gap * (bars.length - 1)) / bars.length;
          const x = pad + i * (barW + gap);
          const y = 68 - item.h;
          return (
            <g key={i}>
              <title>{`${item.label}: ${item.value}`}</title>
              <rect
                x={x.toFixed(1)}
                y={y}
                width={barW.toFixed(1)}
                height={item.h}
                rx="6"
                className="fill-[#8fb6f5] dark:fill-[#8fb6f5]"
              />
              <text
                x={(x + barW / 2).toFixed(1)}
                y="86"
                textAnchor="middle"
                className="fill-muted-foreground text-[11px] font-medium"
              >
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 6-point polyline chart matching beta botLine() */
function FeelsLikeMeChart({ weeks }: { weeks: TwinDetail["report"]["feelsLikeMe"] }) {
  // One point per week with ratings: 100% sits at the top (y 8), 0% at the bottom (y 56).
  const points = weeks.flatMap((pct, i) =>
    pct === null ? [] : [{ x: 16 + (i * (704 - 16)) / Math.max(1, weeks.length - 1), y: 56 - (pct / 100) * 48, pct, week: i + 1 }],
  );
  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  if (!points.length) {
    return (
      <div className="w-full mt-5">
        <p className="m-0 mb-3 text-[13px] font-medium text-muted-foreground">Feels like me, by week</p>
        <p className="m-0 text-sm text-muted-foreground">No calibration ratings in the last 6 weeks.</p>
      </div>
    );
  }

  return (
    <div className="w-full mt-5">
      <p className="m-0 mb-3 text-[13px] font-medium text-muted-foreground">Feels like me, by week</p>
      <svg viewBox="0 0 720 88" className="w-full h-auto max-h-[88px] overflow-visible" role="img" aria-label="Feels like me rate by week">
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="#34d399"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((p) => (
          <g key={p.week}>
            <title>{`Week ${p.week}: ${p.pct}% feels like me`}</title>
            <circle cx={p.x} cy={p.y} r="4" fill="#34d399" />
            <text
              x={p.x}
              y="78"
              textAnchor="middle"
              className="fill-muted-foreground text-[11px] font-medium"
            >
              {p.week}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function TwinAgentDetailPage({ twin }: { twin: TwinDetail }) {
  const id = twin.slug;
  const [dateFilter, setDateFilter] = useState("30");
  const [tab, setTab] = useState<"calibration" | "sessions">("calibration");

  const dateLabel = DATE_OPTIONS.find((o) => o.value === dateFilter)?.label || "Last 30 days";
  const calibrations = twin.calibrations.filter((item) => inRange(item.at, dateFilter));
  const sessions = twin.sessions.filter((item) => inRange(item.at, dateFilter));
  const { minutes, used } = twin.credit;
  const pendingReports = usePendingReports(id, twin.report.pendingReports);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 md:px-0 pt-5 pb-16">
        {/* Header Bar matching Reference 11.47.30 */}
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link
            href="/twin"
            className="inline-flex items-center gap-2 text-sm text-(--foreground) hover:text-muted-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Back</span>
          </Link>

          <div className="flex items-center gap-3">
            {/* Date range dropdown pill */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex h-8 items-center justify-between gap-2.5 rounded-full border border-(--border) bg-transparent px-4 text-[13px] font-normal text-(--foreground) transition-colors hover:bg-(--tone-control) outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
                  >
                    <span>{dateLabel}</span>
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44 rounded-[12px] p-1 bg-card border border-(--card-border) shadow-lg">
                <DropdownMenuGroup>
                  {DATE_OPTIONS.map((opt) => {
                    const isSelected = opt.value === dateFilter;
                    return (
                      <DropdownMenuItem
                        key={opt.value}
                        onClick={() => setDateFilter(opt.value)}
                        className="flex items-center justify-between rounded-[8px] px-3 py-2 text-[13px] text-(--foreground) hover:bg-(--tone-control) cursor-pointer"
                      >
                        <span>{opt.label}</span>
                        {isSelected && <Check className="size-3.5 text-(--brand)" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Calibrate button */}
            <Link
              href={`/twin/${id}/calibrate`}
              className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-4 text-[13px] font-medium text-white shadow-none transition-colors hover:bg-[#e04d00] dark:hover:bg-[#ff7e33]"
            >
              <Sliders className="size-3.5" />
              <span>Calibrate</span>
            </Link>

            {/* 3-dots actions menu */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="More actions"
                    className="grid size-8 place-items-center rounded-full border border-(--border) bg-transparent text-muted-foreground hover:bg-(--tone-control) hover:text-(--foreground) transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
                  >
                    <MoreDotsIcon />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-44 rounded-[12px] p-1 bg-card border border-(--card-border) shadow-lg">
                <DropdownMenuGroup>
                  <DropdownMenuItem render={<Link href={`/twin/${id}/edit`} />}>
                    <Settings2 className="size-4" />
                    <span>Configure</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link href={`/talk?agent=${encodeURIComponent(id)}`} />}>
                    <Play className="size-4" />
                    <span>Try as learner</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link href={`/twin/${id}/assign`} />}>
                    <UserPlus className="size-4" />
                    <span>Assign</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copyTwinLink(id)}>
                    <Share2 className="size-4" />
                    <span>Share</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                    <Trash2 className="size-4" />
                    <span>Remove</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* 2-Column Layout matching Reference Grid */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
          {/* Card 1: Left column - Agent Description & Credit */}
          <article className="flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h1 className="m-0 line-clamp-2 text-[18px] font-semibold leading-7 tracking-[-0.015em]" title={twin.name}>
              {twin.name}
            </h1>

            <div className="mt-6">
              <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Who asks</p>
              <p className="mt-1 line-clamp-1 text-[20px] font-semibold leading-7" title={twin.whoAsks}>
                {twin.whoAsks}
              </p>
            </div>

            <div className="mt-6">
              <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">What it does</p>
              <p
                className="mt-1 line-clamp-4 text-[15px] leading-6 text-(--text-secondary)"
                title={twin.description ?? undefined}
              >
                {twin.description ?? "No description yet."}
              </p>
            </div>

            {/* Usage Credit Box pinned to bottom */}
            <div className="mt-auto pt-6">
              <div className="rounded-[12px] bg-(--sidebar) p-5 flex flex-col gap-2">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Usage credit</p>
                {minutes ? (
                  <>
                    <p className="m-0 text-[20px] font-semibold leading-6 tabular-nums">
                      {used} <span className="text-sm font-normal text-muted-foreground">of {minutes} min used</span>
                    </p>
                    <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-card">
                      <span className="block h-full rounded-full bg-(--foreground)" style={{ width: `${Math.min(100, Math.round((used / minutes) * 100))}%` }} />
                    </span>
                    <p className="m-0 text-xs text-muted-foreground tabular-nums">{Math.max(0, minutes - used)} minutes left</p>
                  </>
                ) : (
                  <p className="m-0 text-sm text-muted-foreground">No minutes assigned yet.</p>
                )}
              </div>
            </div>
          </article>

          {/* Card 2: Right column - Report with 2x2 Stats & 2 Charts */}
          <article className="flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Report</h2>

            {/* 2x2 stats */}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-[12px] bg-emerald-500/10 dark:bg-emerald-500/15 p-4 text-emerald-700 dark:text-emerald-400">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Sessions</p>
                  <Link
                    href="/twin/sessions"
                    className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
                  >
                    View <ArrowUpRight className="size-3.5" />
                  </Link>
                </div>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{twin.report.sessions}</p>
              </div>

              <div className="rounded-[12px] bg-amber-500/10 dark:bg-amber-500/15 p-4 text-amber-700 dark:text-amber-300">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Help score</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {twin.report.helpScore ?? "—"} {twin.report.helpScore !== null ? <span className="text-sm font-normal opacity-70">/ 5</span> : null}
                </p>
              </div>

              <div className="rounded-[12px] bg-sky-500/10 dark:bg-sky-500/15 p-4 text-sky-700 dark:text-sky-300">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Avg response time</p>
                {/* Not tracked per twin yet. */}
                <p className="mt-2 text-2xl font-semibold tabular-nums">—</p>
              </div>

              <div className="rounded-[12px] bg-(--sidebar) p-4 text-(--foreground)">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">
                  Avg session length
                </p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {twin.report.avgMinutes ?? "—"} {twin.report.avgMinutes !== null ? <span className="text-sm font-normal text-muted-foreground">min</span> : null}
                </p>
              </div>
            </div>

            {/* Two charts */}
            <div className="mt-5 flex flex-col gap-4">
              <WeekBarsChart days={twin.report.week} />
              <FeelsLikeMeChart weeks={twin.report.feelsLikeMe} />
            </div>
          </article>

          {/* Card 3: Full width - Most asked */}
          <article className="col-span-1 md:col-span-2 flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Most asked</h2>
            {twin.report.mostAsked.length ? (
              <ul className="mt-4 flex flex-col gap-3 p-0 list-none">
                {twin.report.mostAsked.map((item) => (
                  <li key={item.question} className="flex items-baseline justify-between gap-4 text-sm">
                    <span className="line-clamp-2 text-(--text-secondary)" title={item.question}>
                      {item.question}
                    </span>
                    <span className="tabular-nums font-semibold text-(--foreground)">{item.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground" role="status">
                {pendingReports > 0 ? "Preparing report…" : "No questions yet."}
              </p>
            )}
          </article>

          {/* Card 4: Full width - Reports raised */}
          <article className="col-span-1 md:col-span-2 flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Reports raised</h2>
            <p className="mt-4 text-sm text-muted-foreground">Not tracked yet.</p>
          </article>

          {/* Card 5: Full width - Calibration & Sessions with Segmented Tabs */}
          <article className="col-span-1 md:col-span-2 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            {/* Segmented Control Header matching Reference 11.48.06 */}
            <div className="inline-flex items-center p-1 rounded-full bg-(--sidebar) mb-4">
              <button
                type="button"
                onClick={() => setTab("calibration")}
                className={cn(
                  "rounded-full px-4 py-1.5 text-[14px] leading-5 font-medium transition-all outline-none",
                  tab === "calibration"
                    ? "bg-card text-(--foreground) shadow-[0_1px_2px_rgb(30_28_25/0.06)]"
                    : "text-muted-foreground hover:text-(--foreground)"
                )}
              >
                Calibration
              </button>
              <button
                type="button"
                onClick={() => setTab("sessions")}
                className={cn(
                  "rounded-full px-4 py-1.5 text-[14px] leading-5 font-medium transition-all outline-none",
                  tab === "sessions"
                    ? "bg-card text-(--foreground) shadow-[0_1px_2px_rgb(30_28_25/0.06)]"
                    : "text-muted-foreground hover:text-(--foreground)"
                )}
              >
                Sessions
              </button>
            </div>

            {/* Content List */}
            {tab === "calibration" ? (
              <div className="flex flex-col">
                {calibrations.length === 0 ? (
                  <p className="py-3.5 text-sm text-muted-foreground">No calibrations in this period.</p>
                ) : null}
                {calibrations.map((item, idx) => (
                  <Link
                    key={item.id}
                    href={`/twin/${id}/calibration/${item.id}`}
                    className={cn(
                      "flex items-center justify-between py-3.5 transition-colors hover:text-(--brand)",
                      idx > 0 && "border-t border-(--border)"
                    )}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[14px] font-medium text-(--foreground)">{item.title}</span>
                      <span className="text-[13px] text-muted-foreground">
                        <SessionTime iso={item.at} />
                        {minutesLabel(item.seconds) ? ` · ${minutesLabel(item.seconds)}` : ""} · {item.turns} turns
                      </span>
                    </div>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            ) : (
              <ul className="flex flex-col p-0 m-0 list-none">
                {sessions.length === 0 ? (
                  <li className="py-3.5 text-sm text-muted-foreground">No learner sessions in this period.</li>
                ) : null}
                {sessions.map((sess, idx) => (
                  <TwinSessionItem
                    key={sess.id}
                    session={sess}
                    index={idx}
                    divider={idx > 0}
                  />
                ))}
              </ul>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}
