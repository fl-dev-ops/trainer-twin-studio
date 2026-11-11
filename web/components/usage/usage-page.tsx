"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { CreditsHistoryTable } from "@/components/credits/credits-history-table";
import { CreditsPager, usePage } from "@/components/credits/credits-pager";
import { LearnerCreditsTable } from "@/components/credits/learner-credits-table";
import { CreditsIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageSection, SECTION_CARD } from "@/components/page-section";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { AppRouter } from "@/lib/app-router";
import type { UsageCategory } from "@/lib/usage-report";
import { cn } from "@/lib/utils";

export type OrgCredits = inferRouterOutputs<AppRouter>["minutes"]["org"];
type Activity = inferRouterOutputs<AppRouter>["minutes"]["activity"];
type Days = 7 | 30 | 90;

/** One colour per kind of use: learners in the brand colour, the team in blue, the rest neutral. */
const mix = (color: string, percent: number) => `color-mix(in oklch, ${color} ${percent}%, transparent)`;
const COLOR: Record<UsageCategory, string> = {
  learnerTwin: "var(--brand)",
  learnerRoleplay: mix("var(--brand)", 55),
  assigned: "var(--brand)",
  calibration: "var(--info)",
  teamTwin: mix("var(--info)", 60),
  teamRoleplay: mix("var(--info)", 30),
};
const LABEL: Record<UsageCategory, string> = {
  learnerTwin: "Learners · twins",
  learnerRoleplay: "Learners · role plays",
  assigned: "Given to learners",
  calibration: "Team · calibration",
  teamTwin: "Team · trying twins",
  teamRoleplay: "Team · trying role plays",
};

const minutes = (value: number) => `${value.toLocaleString()} min`;
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const TABS = ["overview", "details"] as const;

/**
 * Usage (specs/credits.md): Overview has the balance and the credits added; Details has where credits went in a period
 * (twins and role plays, team, learners, every movement).
 */
export function UsagePage({ credits, initialTab }: { credits: OrgCredits; initialTab: string | null }) {
  const [tab, setTab] = useState(TABS.find((name) => name === initialTab) ?? "overview");
  const [days, setDays] = useState<Days>(30);
  const activity = useQuery({
    queryKey: ["minutes.activity", days],
    queryFn: () => api.minutes.activity.query({ days }),
    placeholderData: keepPreviousData,
  });
  const selectTab = (value: unknown) => {
    setTab(value as (typeof TABS)[number]);
    window.history.replaceState(null, "", value === "overview" ? "/usage" : `/usage?tab=${value}`);
  };
  const range = <RangeToggle days={days} onChange={setDays} />;

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader icon={CreditsIcon} title="Usage" description="Where your organization's credits go. 1 credit = 1 minute of practice." />
      <Tabs value={tab} onValueChange={selectTab} className="mt-6 gap-0">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-10 pt-8">
          <BalanceCard credits={credits} />
          <PageSection title="Credits added" description="Free trial credits, minute packs and grants from TrainerTwin, with when they expire.">
            <CreditsHistoryTable rows={credits.grants} empty="No credits added yet." column="expires" />
          </PageSection>
        </TabsContent>

        <TabsContent value="details" className="flex flex-col gap-10 pt-8">
          {activity.data ? <Details activity={activity.data} range={range} /> : <Skeleton className="h-64 w-full rounded-tt-lg" />}
          <LearnersSection credits={credits} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}


function RangeToggle({ days, onChange }: { days: Days; onChange: (days: Days) => void }) {
  return (
    <div role="group" aria-label="Period" className="flex gap-1">
      {([7, 30, 90] as const).map((value) => (
        <Button key={value} size="sm" variant={value === days ? "secondary" : "subtle"} aria-pressed={value === days} onClick={() => onChange(value)}>
          {value}d
        </Button>
      ))}
    </div>
  );
}

function BalanceCard({ credits }: { credits: OrgCredits }) {
  const low = credits.balanceMinutes < credits.defaultMinutes;
  const share = credits.addedMinutes > 0 ? Math.min(100, (credits.balanceMinutes / credits.addedMinutes) * 100) : 0;
  return (
    <section className={cn(SECTION_CARD, "flex flex-col gap-4 p-6")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="m-0 text-sm text-muted-foreground">Remaining credits</p>
          <p className={cn("m-0 mt-1 text-4xl font-semibold tabular-nums tracking-title", low && "text-caution")}>
            {credits.balanceMinutes.toLocaleString()} <span className="text-lg font-normal text-muted-foreground">min</span>
          </p>
        </div>
        {credits.billed ? <Button variant="outline" render={<Link href="/billing" />} nativeButton={false}>Buy credits</Button> : null}
      </div>
      {credits.addedMinutes > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${Math.round(share)}% of the credits added are left`}>
            <div className={cn("h-full w-(--w) rounded-full", low ? "bg-caution" : "bg-foreground")} style={{ "--w": `${share}%` } as CSSProperties} />
          </div>
          <span className="tabular-nums">of {credits.addedMinutes.toLocaleString()} added</span>
        </div>
      ) : null}
      <p className="m-0 text-sm text-muted-foreground">
        {!credits.billed
          ? "Billing isn't set up for this organization yet. Contact TrainerTwin."
          : low
            ? `Not enough to give a new learner their ${credits.defaultMinutes} min.`
            : `Each new learner gets ${credits.defaultMinutes} min; give more on their page (up to ${credits.maxMinutes} min each).`}
        {credits.nextExpiry ? ` ${credits.nextExpiry.minutes.toLocaleString()} min (${credits.nextExpiry.label}) expire ${shortDay(credits.nextExpiry.at)}.` : ""}
      </p>
    </section>
  );
}

function Details({ activity, range }: { activity: Activity; range: ReactNode }) {
  return (
    <>
      <PageSection title="Twins and role plays" description="Minutes of calls on each, in the period." action={range}>
        <div className={cn(SECTION_CARD, "overflow-hidden")}>
          {activity.agents.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Learners</TableHead>
                  <TableHead className="text-right">Team</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell className="text-muted-foreground">{agent.kind === "ROLEPLAY" ? "Role play" : "Twin"}</TableCell>
                    <TableCell className="text-right tabular-nums">{agent.calls}</TableCell>
                    <TableCell className="text-right tabular-nums">{minutes(agent.learnerMinutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">{minutes(agent.teamMinutes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <Empty>No calls in this period.</Empty>}
        </div>
      </PageSection>

      <PageSection title="Team" description="Your admins' and team's own calls, paid from the organization's credits.">
        <div className={cn(SECTION_CARD, "overflow-hidden")}>
          {activity.team.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="text-right">Calibration</TableHead>
                  <TableHead className="text-right">Twins</TableHead>
                  <TableHead className="text-right">Role plays</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.team.map((person) => (
                  <TableRow key={person.userId ?? person.email}>
                    <TableCell className="font-medium">{person.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{minutes(person.calibration)}</TableCell>
                    <TableCell className="text-right tabular-nums">{minutes(person.twins)}</TableCell>
                    <TableCell className="text-right tabular-nums">{minutes(person.roleplays)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{minutes(person.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <Empty>No team calls in this period.</Empty>}
        </div>
      </PageSection>

      <ActivityLog activity={activity} />
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-5 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

type LogEntry = Activity["log"][number];
const FILTERS = { all: "Everything", given: "Given to learners", learners: "Learner calls", team: "Team calls" } as const;
const inFilter = (entry: LogEntry, filter: keyof typeof FILTERS) =>
  filter === "all" || (filter === "given" ? entry.category === "assigned" : filter === "learners" ? entry.category.startsWith("learner") : !entry.category.startsWith("learner") && entry.category !== "assigned");

function describe(entry: LogEntry) {
  const who = entry.person ?? "Someone";
  const agent = entry.agent ?? "a deleted twin or role play";
  switch (entry.category) {
    case "assigned": return entry.minutes < 0 ? `Taken back from ${who}` : `Given to ${who}${entry.by ? ` by ${entry.by}` : ""}`;
    case "learnerTwin": return `${who} practised with ${agent}`;
    case "learnerRoleplay": return `${who} practised ${agent}`;
    case "calibration": return `${who} calibrated ${agent}`;
    case "teamTwin": return `${who} tried ${agent}`;
    case "teamRoleplay": return `${who} tried ${agent}`;
  }
}

function downloadCsv(entries: LogEntry[]) {
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [["Date", "Type", "Person", "Twin or role play", "Minutes", "By", "Note"], ...entries.map((entry) => [entry.at, LABEL[entry.category], entry.person, entry.agent, entry.minutes, entry.by, entry.note])];
  const url = URL.createObjectURL(new Blob([lines.map((line) => line.map(cell).join(",")).join("\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: "trainertwin-usage.csv" }).click();
  URL.revokeObjectURL(url);
}

/** Every credit movement in the period, newest first, as one sentence each. */
function ActivityLog({ activity }: { activity: Activity }) {
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const entries = activity.log.filter((entry) => inFilter(entry, filter));
  const { rows, ...pager } = usePage(entries);
  return (
    <PageSection
      title="Activity log"
      description={activity.logTotal > activity.log.length ? `The latest ${activity.log.length} of ${activity.logTotal} in this period.` : "Every credit given and every call in the period."}
      action={(
        <div className="flex items-center gap-2">
          <NativeSelect aria-label="Show" value={filter} onChange={(event) => setFilter(event.target.value as keyof typeof FILTERS)}>
            {Object.entries(FILTERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
          <Button variant="outline" size="sm" disabled={!entries.length} onClick={() => downloadCsv(entries)}>
            <Download data-icon="inline-start" /> CSV
          </Button>
        </div>
      )}
    >
      <div className={cn(SECTION_CARD, "overflow-hidden")}>
        {rows.length ? (
          <ul className="m-0 list-none p-0">
            {rows.map((entry) => (
              <li key={entry.id} className="flex items-center gap-4 border-t border-(--border) px-5 py-3 text-sm first:border-t-0">
                <span className="size-2 shrink-0 rounded-full bg-(--c)" style={{ "--c": COLOR[entry.category] } as CSSProperties} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{describe(entry)}</span>
                  {entry.note ? <span className="block truncate text-xs text-muted-foreground">{entry.note}</span> : null}
                </span>
                <time dateTime={entry.at} className="shrink-0 text-muted-foreground tabular-nums">{when(entry.at)}</time>
                <span className="w-20 shrink-0 text-right font-medium tabular-nums">{minutes(entry.minutes)}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>Nothing in this period.</Empty>}
        <CreditsPager {...pager} />
      </div>
    </PageSection>
  );
}

function LearnersSection({ credits }: { credits: OrgCredits }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const learners = q ? credits.learners.filter((row) => row.email.includes(q) || row.name?.toLowerCase().includes(q)) : credits.learners;
  return (
    <PageSection
      title="Learners"
      description="What each learner was given, has used and has left, since they joined."
      action={<div className="w-64 max-w-full"><SearchInput placeholder="Search learners" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search learners" /></div>}
    >
      <LearnerCreditsTable rows={learners} empty={q ? `No learner matches “${query.trim()}”.` : "No learner has credits yet. They get theirs when you invite or assign them."} />
    </PageSection>
  );
}
