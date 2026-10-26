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
import { TwinSessionItem, TWIN_SESSIONS_MOCK } from "@/components/twin/twin-session-item";
import { cn } from "@/lib/utils";

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
function WeekBarsChart() {
  const bars = [
    { label: "Mon", value: 8, h: 36 },
    { label: "Tue", value: 14, h: 58 },
    { label: "Wed", value: 6, h: 26 },
    { label: "Thu", value: 11, h: 48 },
    { label: "Fri", value: 4, h: 18 },
    { label: "Sat", value: 9, h: 40 },
    { label: "Sun", value: 12, h: 52 },
  ];

  return (
    <div className="w-full">
      <p className="m-0 mb-3 text-[13px] font-medium text-muted-foreground">Conversations this week</p>
      <svg viewBox="0 0 720 96" className="w-full h-auto max-h-[96px] overflow-visible" role="img" aria-label="Sessions this week">
        {bars.map((item, i) => {
          const width = 720;
          const pad = 4;
          const gap = 18;
          const barW = (width - pad * 2 - gap * (bars.length - 1)) / bars.length;
          const x = pad + i * (barW + gap);
          const y = 68 - item.h;
          return (
            <g key={item.label}>
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
function FeelsLikeMeChart() {
  const points = [
    { x: 16, y: 32 },
    { x: 153.6, y: 24 },
    { x: 291.2, y: 36 },
    { x: 428.8, y: 22 },
    { x: 566.4, y: 30 },
    { x: 704, y: 18 },
  ];

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");

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
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="4" fill="#34d399" />
            <text
              x={p.x}
              y="78"
              textAnchor="middle"
              className="fill-muted-foreground text-[11px] font-medium"
            >
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

const CALIBRATIONS = [
  {
    id: "cal-prices",
    title: "Handling “prices will drop next year”",
    when: "Today, 11:11 · 6 min · 15 turns",
  },
  {
    id: "cal-fee",
    title: "Pushing back on a one percent fee",
    when: "Yesterday, 4:20 · 5 min · 4 turns",
  },
  {
    id: "cal-landlord",
    title: "Opening a cold call with a landlord",
    when: "Mon, 10:05 · 4 min · 4 turns",
  },
  {
    id: "cal-viewing",
    title: "Following up after a viewing",
    when: "Sun, 6:48 · 2 min · 3 turns",
  },
];

export function TwinAgentDetailPage({ id }: { id: string }) {
  const [dateFilter, setDateFilter] = useState("30");
  const [tab, setTab] = useState<"calibration" | "sessions">("calibration");

  const dateLabel = DATE_OPTIONS.find((o) => o.value === dateFilter)?.label || "Last 30 days";

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
              href={`/calibration/${id}`}
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
                  <DropdownMenuItem render={<Link href="/dash/talk" />}>
                    <Play className="size-4" />
                    <span>Try as learner</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link href={`/twin/${id}/assign`} />}>
                    <UserPlus className="size-4" />
                    <span>Assign</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        navigator.clipboard?.writeText(window.location.href);
                      }
                    }}
                  >
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
            <h1 className="m-0 text-[18px] font-semibold leading-7 tracking-[-0.015em]">The off-plan sales process</h1>

            <div className="mt-6">
              <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Who asks</p>
              <p className="mt-1 text-[20px] font-semibold leading-7">Agent</p>
            </div>

            <div className="mt-6">
              <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">What it does</p>
              <p className="mt-1 text-[15px] leading-6 text-(--text-secondary)">
                First call, educational Zoom and presentation meeting. Every stage books the next one.
              </p>
            </div>

            {/* Usage Credit Box pinned to bottom */}
            <div className="mt-auto pt-6">
              <div className="rounded-[12px] bg-(--sidebar) p-5 flex flex-col gap-2">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">Usage credit</p>
                <p className="m-0 text-[20px] font-semibold leading-6 tabular-nums">
                  190 <span className="text-sm font-normal text-muted-foreground">of 300 min used</span>
                </p>
                <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-card">
                  <span className="block h-full rounded-full bg-(--foreground)" style={{ width: "63%" }} />
                </span>
                <p className="m-0 text-xs text-muted-foreground tabular-nums">110 minutes left</p>
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
                <p className="mt-2 text-2xl font-semibold tabular-nums">112</p>
              </div>

              <div className="rounded-[12px] bg-amber-500/10 dark:bg-amber-500/15 p-4 text-amber-700 dark:text-amber-300">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Help score</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  4.8 <span className="text-sm font-normal opacity-70">/ 5</span>
                </p>
              </div>

              <div className="rounded-[12px] bg-sky-500/10 dark:bg-sky-500/15 p-4 text-sky-700 dark:text-sky-300">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase">Avg response time</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">1.6 s</p>
              </div>

              <div className="rounded-[12px] bg-(--sidebar) p-4 text-(--foreground)">
                <p className="text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">
                  Avg session length
                </p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  3.6 <span className="text-sm font-normal text-muted-foreground">min</span>
                </p>
              </div>
            </div>

            {/* Two charts */}
            <div className="mt-5 flex flex-col gap-4">
              <WeekBarsChart />
              <FeelsLikeMeChart />
            </div>
          </article>

          {/* Card 3: Full width - Most asked */}
          <article className="col-span-1 md:col-span-2 flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Most asked</h2>
            <ul className="mt-4 flex flex-col gap-3 p-0 list-none">
              <li className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-(--text-secondary)">
                  What do I say when a client asks “what good opportunities do you have?”
                </span>
                <span className="tabular-nums font-semibold text-(--foreground)">38</span>
              </li>
              <li className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-(--text-secondary)">
                  In the meeting, do I first explain the market?
                </span>
                <span className="tabular-nums font-semibold text-(--foreground)">25</span>
              </li>
              <li className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-(--text-secondary)">What numbers do I present?</span>
                <span className="tabular-nums font-semibold text-(--foreground)">17</span>
              </li>
            </ul>
          </article>

          {/* Card 4: Full width - Reports raised */}
          <article className="col-span-1 md:col-span-2 flex flex-col rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">Reports raised</h2>
            <ul className="mt-4 flex flex-col gap-3 p-0 list-none">
              <li className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-(--text-secondary)">Total reports</span>
                <span className="tabular-nums font-semibold text-(--foreground)">16</span>
              </li>
              <li className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-(--text-secondary)">Most common report</span>
                <span className="font-medium text-(--foreground)">Sounds robotic</span>
              </li>
            </ul>
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
                {CALIBRATIONS.map((item, idx) => (
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
                      <span className="text-[13px] text-muted-foreground">{item.when}</span>
                    </div>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            ) : (
              <ul className="flex flex-col p-0 m-0 list-none">
                {TWIN_SESSIONS_MOCK.filter(
                  (s) => s.bot === "The off-plan sales process" || s.bot === id
                ).map((sess, idx) => (
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
