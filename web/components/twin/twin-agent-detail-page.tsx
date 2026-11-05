"use client";

import Link from "next/link";
import { useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowUpRight,
  FileText,
  Play,
  Settings2,
  Share2,
  Sliders,
  Sparkles,
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
import { DATE_RANGES, FilterDropdown, inDateRange } from "@/components/filter-dropdown";
import { PageHeader } from "@/components/page-header";
import { SessionTime } from "@/components/sessions/session-time";
import { ShareTwinDialog } from "@/components/twin/share-twin-dialog";
import { TwinSessionItem } from "@/components/twin/twin-session-item";
import { TwinLearnerActivity, type TwinLearner } from "@/components/twin/twin-learner-activity";
import { usePendingReports } from "@/components/twin/use-report-polling";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TwinDetail = TwinOutputs["agents"]["get"];

/** Twin agents listed on the main twin's card before "+N more". */
const SKILLS_SHOWN = 5;
const minutesLabel = (seconds: number | null) => (seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min`);

/** The overline label (design-system type role): small caps over a value. */
const OVERLINE = "text-overline font-medium tracking-overline uppercase";

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
      <p className="m-0 mb-3 text-body-s font-medium text-muted-foreground">Conversations, last 7 days</p>
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
                className="fill-info-border"
              />
              <text
                x={(x + barW / 2).toFixed(1)}
                y="86"
                textAnchor="middle"
                className="fill-muted-foreground text-overline font-medium"
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
        <p className="m-0 mb-3 text-body-s font-medium text-muted-foreground">Feels like me, by week</p>
        <p className="m-0 text-sm text-muted-foreground">No calibration ratings in the last 6 weeks.</p>
      </div>
    );
  }

  return (
    <div className="w-full mt-5">
      <p className="m-0 mb-3 text-body-s font-medium text-muted-foreground">Feels like me, by week</p>
      <svg viewBox="0 0 720 88" className="w-full h-auto max-h-[88px] overflow-visible" role="img" aria-label="Feels like me rate by week">
        <polyline
          points={polylinePoints}
          fill="none"
          className="stroke-success-border"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((p) => (
          <g key={p.week}>
            <title>{`Week ${p.week}: ${p.pct}% feels like me`}</title>
            <circle cx={p.x} cy={p.y} r="4" className="fill-success-border" />
            <text
              x={p.x}
              y="78"
              textAnchor="middle"
              className="fill-muted-foreground text-overline font-medium"
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
  const [shareOpen, setShareOpen] = useState(false);
  const [tab, setTab] = useState("sessions");
  // A learner picked on the Learners tab: the Sessions tab then shows only theirs.
  const [learner, setLearner] = useState<TwinLearner | null>(null);

  const calibrations = twin.calibrations.filter((item) => inDateRange(item.at, dateFilter));
  const sessions = twin.sessions.filter(
    (item) => inDateRange(item.at, dateFilter) && (!learner || item.learnerEmail.toLowerCase() === learner.email),
  );
  const { minutes, used } = twin.credit;
  const pendingReports = usePendingReports(id, twin.report.pendingReports);

  return (
    <PageContainer>
      <PageHeader
        back={{ href: "/twin" }}
        actions={
          <>
            <FilterDropdown value={dateFilter} onChange={setDateFilter} options={DATE_RANGES} align="end" />
            <Button variant="secondary" nativeButton={false} render={<Link href={`/twin/${id}/edit`} />}>
              <Settings2 data-icon="inline-start" />
              Configure
            </Button>
            <Button variant="brand" nativeButton={false} render={<Link href={`/twin/${id}/calibration`} />}>
              <Sliders data-icon="inline-start" />
              Calibrate
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="More actions" />}>
                <MoreDotsIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
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
                  <DropdownMenuItem onClick={() => setShareOpen(true)}>
                    <Share2 className="size-4" />
                    <span>Share</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive">
                    <Trash2 className="size-4" />
                    <span>Remove</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <ShareTwinDialog open={shareOpen} onOpenChange={setShareOpen} slug={id} name={twin.name} allSkills={twin.allSkills} />

      {/* 2-Column Layout matching Reference Grid */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
        {/* Card 1: Left column - Agent Description & Credit */}
        <Card size="lg">
          <CardContent className="flex flex-1 flex-col">
          <h1 className="m-0 line-clamp-2 text-section-title leading-7 font-semibold tracking-title" title={twin.name}>
            {twin.name}
          </h1>

          <div className="mt-6">
            <p className={cn(OVERLINE, "text-muted-foreground")}>Who asks</p>
            <p className="mt-1 line-clamp-1 text-title-m leading-7 font-semibold" title={twin.whoAsks}>
              {twin.whoAsks}
            </p>
          </div>

          {twin.allSkills ? (
            // The main twin covers every skill twin: list them instead of a description.
            <div className="mt-6">
              <p className={cn(OVERLINE, "text-muted-foreground")}>Twin agents</p>
              {twin.skills.length ? (
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                  {twin.skills.slice(0, SKILLS_SHOWN).map((skill) => (
                    <li key={skill.slug}>
                      <Link href={`/twin/${encodeURIComponent(skill.slug)}`} className="flex items-center gap-2 text-body leading-6 text-(--text-secondary) hover:text-foreground">
                        <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate">{skill.name}</span>
                      </Link>
                    </li>
                  ))}
                  {twin.skills.length > SKILLS_SHOWN ? (
                    <li>
                      <Link href="/twin" className="text-sm font-medium text-muted-foreground hover:text-foreground">
                        +{twin.skills.length - SKILLS_SHOWN} more
                      </Link>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="mt-1 text-body leading-6 text-(--text-secondary)">No twin agents yet.</p>
              )}
            </div>
          ) : (
            <div className="mt-6">
              <p className={cn(OVERLINE, "text-muted-foreground")}>What it does</p>
              <p
                className="mt-1 line-clamp-4 text-body leading-6 text-(--text-secondary)"
                title={twin.description ?? undefined}
              >
                {twin.description ?? "No description yet."}
              </p>
            </div>
          )}

          {/* Usage Credit Box pinned to bottom */}
          <div className="mt-auto pt-6">
            <div className="flex flex-col gap-2 rounded-tt-md bg-sidebar p-5">
              <p className={cn(OVERLINE, "text-muted-foreground")}>Usage credit</p>
              {minutes ? (
                <>
                  <p className="m-0 text-title-m leading-6 font-semibold tabular-nums">
                    {used} <span className="text-sm font-normal text-muted-foreground">of {minutes} min used</span>
                  </p>
                  <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-card">
                    <span
                      className="block h-full w-(--used) rounded-full bg-foreground"
                      style={{ "--used": `${Math.min(100, Math.round((used / minutes) * 100))}%` } as CSSProperties}
                    />
                  </span>
                  <p className="m-0 text-xs text-muted-foreground tabular-nums">{Math.max(0, minutes - used)} minutes left</p>
                </>
              ) : (
                <p className="m-0 text-sm text-muted-foreground">No minutes assigned yet.</p>
              )}
            </div>
          </div>
          </CardContent>
        </Card>

        {/* Card 2: Right column - Report with 2x2 Stats & 2 Charts */}
        <Card size="lg">
          <CardContent className="flex flex-col">
          <h2 className="m-0 text-title-s font-semibold tracking-title">Report</h2>

          {/* 2x2 stats */}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-tt-md bg-success-subtle p-4 text-success">
              <div className="flex items-center justify-between gap-2">
                <p className={OVERLINE}>Sessions</p>
                <Link
                  href="/twin/sessions"
                  className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
                >
                  View <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{twin.report.sessions}</p>
            </div>

            <div className="rounded-tt-md bg-caution-subtle p-4 text-caution">
              <p className={OVERLINE}>Help score</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {twin.report.helpScore ?? "—"} {twin.report.helpScore !== null ? <span className="text-sm font-normal opacity-70">/ 5</span> : null}
              </p>
            </div>

            <div className="rounded-tt-md bg-info-subtle p-4 text-info">
              <p className={OVERLINE}>Avg response time</p>
              {/* Not tracked per twin yet. */}
              <p className="mt-2 text-2xl font-semibold tabular-nums">—</p>
            </div>

            <div className="rounded-tt-md bg-sidebar p-4 text-foreground">
              <p className={cn(OVERLINE, "text-muted-foreground")}>
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
          </CardContent>
        </Card>

        {/* Full width: the knowledge base documents this twin's live version was built from (the main twin: its skills'). */}
        <Card size="lg" className="md:col-span-2">
          <CardContent>
            <h2 className="m-0 text-title-s font-semibold tracking-title">Built from</h2>
            {twin.builtFrom ? (
              <ItemGroup divided className="mt-2">
                {twin.builtFrom.map((doc) => (
                  <Item key={doc.documentId} size="row">
                    <ItemMedia variant="icon">
                      <FileText className="text-muted-foreground" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {doc.exists ? (
                          <Link href={`/twin/knowledge?doc=${encodeURIComponent(doc.documentId)}`} className="hover:underline">
                            {doc.title}
                          </Link>
                        ) : (
                          doc.title
                        )}
                      </ItemTitle>
                      {doc.exists ? null : <ItemDescription>No longer in the knowledge base</ItemDescription>}
                    </ItemContent>
                    <ItemActions>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {doc.items} {doc.items === 1 ? "item" : "items"}
                      </span>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                {twin.allSkills ? "Not recorded for its twin agents yet." : "Not recorded for this version."}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Card 3: Full width - Most asked */}
        <Card size="lg" className="md:col-span-2">
          <CardContent>
          <h2 className="m-0 text-title-s font-semibold tracking-title">Most asked</h2>
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
          </CardContent>
        </Card>

        {/* Card 4: Full width - Reports raised */}
        <Card size="lg" className="md:col-span-2">
          <CardContent>
            <h2 className="m-0 text-title-s font-semibold tracking-title">Reports raised</h2>
            <p className="mt-4 text-sm text-muted-foreground">Not tracked yet.</p>
          </CardContent>
        </Card>

        {/* Card 5: Full width - this twin's sessions first (where insights will grow), then its calibrations */}
        <Card size="lg" className="md:col-span-2">
          <CardContent>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="learners">Learners</TabsTrigger>
              <TabsTrigger value="calibration">Calibration</TabsTrigger>
            </TabsList>
            <TabsContent value="sessions">
              {learner ? (
                <p className="mb-2 flex items-center gap-2 text-body-s text-muted-foreground">
                  Showing {learner.name}&apos;s sessions
                  <Button variant="ghost" size="xs" onClick={() => setLearner(null)}>
                    Show all
                  </Button>
                </p>
              ) : null}
              <ul className="m-0 flex list-none flex-col p-0">
              {sessions.length === 0 ? (
                <li className="py-3.5 text-sm text-muted-foreground">
                  {learner ? `No sessions from ${learner.name} in this period.` : "No learner sessions in this period."}
                </li>
              ) : null}
              {sessions.map((sess, idx) => (
                <TwinSessionItem
                  key={sess.id}
                  session={sess}
                  divider={idx > 0}
                />
              ))}
              </ul>
            </TabsContent>
            <TabsContent value="learners">
              <TwinLearnerActivity
                learners={twin.learners}
                onSelect={(picked) => {
                  setLearner(picked);
                  setTab("sessions");
                }}
              />
            </TabsContent>
            <TabsContent value="calibration" className="flex flex-col">
              {calibrations.length === 0 ? (
                <p className="py-3.5 text-sm text-muted-foreground">No calibrations in this period.</p>
              ) : null}
              {calibrations.map((item, idx) => (
                <Link
                  key={item.id}
                  href={`/twin/${id}/calibration/${item.id}`}
                  className={cn(
                    "flex items-center justify-between py-3.5 transition-colors hover:text-brand",
                    idx > 0 && "border-t border-border"
                  )}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-body font-medium text-foreground">{item.title}</span>
                    <span className="text-body-s text-muted-foreground">
                      <SessionTime iso={item.at} />
                      {minutesLabel(item.seconds) ? ` · ${minutesLabel(item.seconds)}` : ""} · {item.turns} turns
                    </span>
                  </div>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </TabsContent>
          </Tabs>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
