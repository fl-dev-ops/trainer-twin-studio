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
import { TwinLearnerActivity } from "@/components/twin/twin-learner-activity";
import { usePendingReports } from "@/components/twin/use-report-polling";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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

/** Donut showing the share of learner minutes used. */
function UsageRing({ used, minutes }: { used: number; minutes: number }) {
  const pct = minutes ? Math.min(100, Math.round((used / minutes) * 100)) : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-16 shrink-0">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-card" />
        <circle
          cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
          className={pct ? "stroke-brand" : "stroke-transparent"}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-xs font-semibold tabular-nums">{minutes ? `${pct}%` : "—"}</span>
    </div>
  );
}

/** 7-bar chart; bars stretch to fill the card's height and scale to the busiest day. */
function WeekBarsChart({ days }: { days: TwinDetail["report"]["week"] }) {
  const top = Math.max(1, ...days.map((day) => day.value));
  return (
    <div className="flex flex-1 flex-col">
      <p className="m-0 mb-3 text-body-s font-medium text-muted-foreground">Conversations, last 7 days</p>
      <div className="flex min-h-40 flex-1 items-end gap-3" role="img" aria-label="Sessions this week">
        {days.map((day, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center gap-2" title={`${day.label}: ${day.value}`}>
            {/* Grow ratios (spacer vs bar) size the bar without needing a fixed parent height; an empty day keeps a 2px stub. */}
            <div className="flex w-full flex-1 flex-col">
              <div className="grow-(--rest)" style={{ "--rest": top - day.value } as CSSProperties} />
              <div className="min-h-0.5 w-full grow-(--value) rounded-md bg-info-border" style={{ "--value": day.value } as CSSProperties} />
            </div>
            <span className="text-overline font-medium text-muted-foreground">{day.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TwinAgentDetailPage({ twin }: { twin: TwinDetail }) {
  const id = twin.slug;
  const [dateFilter, setDateFilter] = useState("30");
  const [shareOpen, setShareOpen] = useState(false);
  const [tab, setTab] = useState("sessions");
  const [builtFromOpen, setBuiltFromOpen] = useState(false);
  const fileCount = twin.builtFrom?.length ?? 0;
  const filesLabel = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;

  const calibrations = twin.calibrations.filter((item) => inDateRange(item.at, dateFilter));
  const sessions = twin.sessions.filter((item) => inDateRange(item.at, dateFilter));
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
        {/* Card 1: Full width - Agent Description, Built from & Credit */}
        <Card size="lg" className="md:col-span-2">
          <CardContent className="flex flex-1 flex-col">
          <div className="flex flex-col gap-6 md:flex-row md:justify-between">
            <div className="min-w-0 flex-1">
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
            </div>

            {/* Usage credit: compact ring beside the description. */}
            <div className="flex items-center gap-4 self-start rounded-tt-md bg-sidebar p-4 md:w-72">
              <UsageRing used={used} minutes={minutes} />
              <div className="flex min-w-0 flex-col gap-1">
                <p className={cn(OVERLINE, "text-muted-foreground")}>Learner minutes</p>
                {minutes ? (
                  <>
                    <p className="m-0 text-title-m leading-6 font-semibold tabular-nums">
                      {used} <span className="text-sm font-normal text-muted-foreground">of {minutes} min used</span>
                    </p>
                    <p className="m-0 text-xs text-muted-foreground tabular-nums">{Math.max(0, minutes - used)} minutes left</p>
                  </>
                ) : (
                  <p className="m-0 text-sm text-muted-foreground">No minutes assigned yet.</p>
                )}
              </div>
            </div>
          </div>

          {/* The knowledge base documents this twin's live version was built from (the main twin: its skills'); full list opens in a sheet. */}
          <div className="mt-6 border-t border-border pt-6">
            <p className={cn(OVERLINE, "text-muted-foreground")}>Built this agent from</p>
            {twin.builtFrom ? (
              <button
                type="button"
                onClick={() => setBuiltFromOpen(true)}
                className="mt-2 flex w-full items-center gap-3 rounded-tt-md bg-sidebar px-4 py-3 text-left text-body transition-colors hover:bg-muted"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1">{filesLabel}</span>
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  View all <ArrowUpRight className="size-3.5" />
                </span>
              </button>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {twin.allSkills ? "Not recorded for its twin agents yet." : "Not recorded for this version."}
              </p>
            )}
          </div>
          </CardContent>
        </Card>

        {/* Card 2: Left column - Report 2x2 stats */}
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
          </CardContent>
        </Card>

        {/* Card 3: Right column - Activity charts */}
        <Card size="lg">
          <CardContent className="flex flex-col">
            <h2 className="m-0 text-title-s font-semibold tracking-title">Activity</h2>
            <div className="mt-4 flex flex-1 flex-col">
              <WeekBarsChart days={twin.report.week} />
            </div>
          </CardContent>
        </Card>

        <Sheet open={builtFromOpen} onOpenChange={setBuiltFromOpen}>
          <SheetContent side="right" className="sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Built from</SheetTitle>
              <SheetDescription>{filesLabel}</SheetDescription>
            </SheetHeader>
            {twin.builtFrom ? (
              <ItemGroup divided className="overflow-y-auto px-4 pb-4">
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
                  </Item>
                ))}
              </ItemGroup>
            ) : null}
          </SheetContent>
        </Sheet>

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

        {/* Full width: what learners asked that the twin declined (outside its playbooks), counted like Most asked */}
        <Card size="lg" className="md:col-span-2">
          <CardContent>
            <h2 className="m-0 text-title-s font-semibold tracking-title">Couldn&apos;t answer</h2>
            {twin.report.couldntAnswer.length ? (
              <ul className="mt-4 flex flex-col gap-3 p-0 list-none">
                {twin.report.couldntAnswer.map((item) => (
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
                {pendingReports > 0 ? "Preparing report…" : "Nothing yet."}
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
              <ul className="m-0 flex list-none flex-col p-0">
              {sessions.length === 0 ? (
                <li className="py-3.5 text-sm text-muted-foreground">No learner sessions in this period.</li>
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
              <TwinLearnerActivity learners={twin.learners} />
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
