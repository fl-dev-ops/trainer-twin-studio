"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { GRADIENTS, LearnerAvatars } from "@/components/library-card-parts";
import { SessionTime } from "@/components/sessions/session-time";
import { scoreTone } from "@/components/roleplay/roleplay-session-item";
import { HelpfulStars } from "@/components/twin/twin-session-item";
import { TwinFace } from "@/components/twin/twin-face";
import { Badge } from "@/components/ui/badge";
import { PersonaPhoto, RoleChip } from "@/components/persona/persona-parts";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar, UserAvatarGroup } from "@/components/user-avatar";
import { api } from "@/lib/api";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { dashRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The copilot's cards for the things it talks about: twins, role plays and sessions (phase 3.2,
 * plans/copilot-everywhere.md). Small versions of the studio's own cards (the twin and role-play library cards, the
 * session pages), each opening its page.
 *
 * The model's tool output only names the item (slug or id); the card loads what it shows (faces, learners, report)
 * from the studio API with the trainer's own session, like the pages do. So none of it passes through the model, and
 * a card shows the item as it is now. When the studio can't find it (just archived, another kind), the card falls
 * back to what the copilot read.
 */

/** The studio data behind the cards, cached once per conversation view (own keys: pages store a different shape). */
const STALE = 30_000;
const useTwinLibrary = () =>
  useQuery({ queryKey: ["copilot.cards.twins"], queryFn: () => api.twin.agents.list.query(), staleTime: STALE });
const usePersonaLibrary = () =>
  useQuery({ queryKey: ["copilot.cards.personas"], queryFn: () => api.page.personas.query(), staleTime: STALE });
const useRoleplayLibrary = () =>
  useQuery({ queryKey: ["copilot.cards.roleplays"], queryFn: () => api.roleplay.scenarios.list.query(), staleTime: STALE });

/** A learner as the copilot names them: a name, never an email shown in its place (lib/copilot-reads.ts nameOnly). */
const shownName = (name: string | null | undefined) => (name && !/\S+@\S+\.\S+/.test(name) ? name : "Unnamed learner");
const lengthOf = (seconds: number | null) => (seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min`);
/** A stable gradient per item, so the same twin keeps its colour across the conversation. */
const gradientFor = (slug: string) => GRADIENTS[[...slug].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 0) % GRADIENTS.length];

/** The card's shell: the studio card (12px, card border, elevation-1, lifts on hover), the whole of it a link. */
function CardLink({ href, label, children, className }: { href: Route; label: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(
        "group/card flex min-w-0 overflow-hidden rounded-tt-md border border-(--card-border) bg-card text-left shadow-elevation-1 outline-none transition-[box-shadow,translate] duration-200 ease-(--ease-studio) hover:-translate-y-px hover:shadow-elevation-2 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="flex overflow-hidden rounded-tt-md border border-(--card-border) bg-card">
      <Skeleton className="h-22 w-18 shrink-0 rounded-none" />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

/** What the copilot's own read says about an item: the fallback when the studio's data doesn't have it. */
export type ReadItem = { slug: string; name: string; kind: string; version?: number; description?: string | null; archived?: boolean };

const KIND_WORD: Record<string, string> = {
  "main-twin": "All skills",
  "twin-skill": "Twin skill",
  "twin-skill-legacy": "Twin skill",
  "roleplay-builder": "Role play",
  "roleplay-brief": "Role play",
  "roleplay-recordings": "Role play",
};

/** The body every library card shares: name, a two-line description, learners and what kind of thing it is. */
function LibraryBody({ name, description, learners, kind, version, archived }: {
  name: string;
  description: string | null | undefined;
  learners: React.ReactNode;
  kind: string;
  version?: number;
  archived?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5">
      <span className="line-clamp-1 text-body-s leading-body-s font-semibold tracking-title text-foreground">{name}</span>
      {description ? <span className="line-clamp-2 text-body-s leading-body-s text-(--text-secondary)">{description}</span> : null}
      <span className="mt-auto flex items-center justify-between gap-2 pt-1">
        {learners}
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {archived ? <Badge variant="secondary" size="sm">Archived</Badge> : null}
          {KIND_WORD[kind] ?? "Twin"}
          {version ? <span className="tabular-nums">· v{version}</span> : null}
        </span>
      </span>
    </div>
  );
}

/** A twin: its face on its gradient (the library card's art, as a tile), and the library card's body. */
export function TwinCard({ item }: { item: ReadItem }) {
  const library = useTwinLibrary();
  if (library.isPending) return <CardSkeleton />;
  const twin = [...(library.data?.twins ?? []), ...(library.data?.skills ?? [])].find((t) => t.slug === item.slug);
  return (
    <CardLink href={dashRoute(`/twin/${item.slug}`)} label={`Open ${twin?.name ?? item.name}`}>
      <span className={cn("grid w-18 shrink-0 place-items-center", gradientFor(item.slug))}>
        {twin ? (
          <TwinFace face={twin.face} size="lg" shape={twin.allSkills ? "rounded" : "circle"} />
        ) : (
          <UserAvatar user={{ name: item.name }} size="lg" />
        )}
      </span>
      <LibraryBody
        name={twin?.name ?? item.name}
        description={twin?.description ?? item.description}
        learners={twin ? <LearnerAvatars learners={twin.learners} /> : <span />}
        kind={twin ? (twin.allSkills ? "main-twin" : "twin-skill") : item.kind}
        version={item.version}
        archived={item.archived}
      />
    </CardLink>
  );
}

/** A role play: who plays it on its gradient, and the library card's body. */
export function RoleplayCard({ item }: { item: ReadItem }) {
  const library = useRoleplayLibrary();
  if (library.isPending) return <CardSkeleton />;
  const scenario = library.data?.find((s) => s.slug === item.slug);
  const people = scenario ? (scenario.personas.length ? scenario.personas : [scenario.client]) : [];
  return (
    <CardLink href={scenario?.href ?? dashRoute(`/roleplay/${item.slug}`)} label={`Open ${scenario?.name ?? item.name}`}>
      <span className={cn("grid w-18 shrink-0 place-items-center", gradientFor(item.slug))}>
        {people.length > 1 ? (
          <UserAvatarGroup users={people.map((p) => ({ name: p.name, image: p.photoUrl }))} max={2} size="sm" />
        ) : (
          <UserAvatar user={{ name: people[0]?.name ?? item.name, image: people[0]?.photoUrl }} size="lg" />
        )}
      </span>
      <LibraryBody
        name={scenario?.name ?? item.name}
        description={scenario?.description ?? item.description}
        learners={scenario ? <LearnerAvatars learners={scenario.learners} label="Learners assigned to this role play" /> : <span />}
        kind={item.kind}
        version={item.version}
        archived={item.archived}
      />
    </CardLink>
  );
}

/** A persona: their photo, who they are, how they come across, their voice and how many agents use them (as in Personas). */
export function PersonaCard({ slug, name }: { slug: string; name: string }) {
  const library = usePersonaLibrary();
  if (library.isPending) return <CardSkeleton />;
  const item = library.data?.find((p) => p.slug === slug);
  const persona = item?.persona;
  return (
    <CardLink href={dashRoute(`/personas/${encodeURIComponent(slug)}`)} label={`Open ${persona?.name ?? name}`} className="flex-col gap-2 p-3">
      <span className="flex items-center gap-3">
        <PersonaPhoto name={persona?.name ?? name} photoUrl={item?.photoUrl ?? null} />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="max-w-full truncate text-body-s leading-body-s font-semibold tracking-title text-foreground">{persona?.name ?? name}</span>
          <RoleChip className={cn("text-xs", item?.isOwn && "bg-(--brand)/15 text-(--brand-strong) dark:text-(--brand)")}>
            {item?.isOwn ? "Your persona" : persona?.role || "No role yet"}
          </RoleChip>
        </span>
      </span>
      {persona?.about ? <span className="line-clamp-2 text-body-s leading-body-s text-(--text-secondary)">{persona.about}</span> : null}
      {item ? (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{item.voice ? `Voice: ${item.voice.name}` : "No voice yet"}</span>
          <span>{item.usedBy.length ? `Used by ${item.usedBy.length} ${item.usedBy.length === 1 ? "agent" : "agents"}` : "Not used yet"}</span>
        </span>
      ) : null}
    </CardLink>
  );
}

/** Several twins or role plays: stacked cards, the first few, the rest a click away. */
export function LibraryCards({ items, kind, more, onMore }: { items: ReadItem[]; kind: "twin" | "roleplay"; more: number; onMore: () => void }) {
  const Card = kind === "twin" ? TwinCard : RoleplayCard;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => <Card key={item.slug} item={item} />)}
      {more > 0 ? (
        <button
          type="button"
          onClick={onMore}
          className="self-start rounded-full px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show {more} more
        </button>
      ) : null}
    </div>
  );
}

/** What the copilot's session read says: the fallback when the studio's own session view isn't available. */
export type ReadSession = {
  id: string;
  kind: "twin" | "roleplay" | "bot";
  agent: { name: string };
  learner: string;
  startedAt: string | null;
  minutes: number | null;
  score?: number;
  learnerRating?: number;
  tags?: string[];
  learnerFeedback?: string;
  /** The turns this read returned (lib/copilot-reads.ts sessionDetail): the ones the copilot's answer can cite. */
  transcript?: { totalTurns: number; fromTurn: number; turns: { n: number; speaker: string; text: string }[] };
};

/** The session's header: learner, what they talked to, when and how long. */
function SessionHead({ learner, image, context, at, length }: {
  learner: string;
  image?: string | null;
  context: React.ReactNode;
  at: string | null;
  length: string | null;
}) {
  return (
    <span className="flex items-start gap-3">
      <UserAvatar user={{ name: learner, image }} size="lg" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body-s leading-body-s font-semibold text-foreground">{learner}</span>
        <span className="text-body-s leading-body-s text-muted-foreground">
          {context}
          {at ? <> · <span className="whitespace-nowrap"><SessionTime iso={at} /></span></> : null}
          {length ? <> · <span className="whitespace-nowrap">{length}</span></> : null}
        </span>
      </span>
    </span>
  );
}

const sessionHref = (kind: ReadSession["kind"], id: string) =>
  kind === "roleplay" ? dashRoute(`/roleplay/sessions/${id}`) : dashRoute(`/twin/sessions/${id}`);

/** A session, as its page shows it in brief, with its report and the turns the copilot read a click away. */
export function SessionCard({ session }: { session: ReadSession }) {
  return session.kind === "roleplay" ? <RoleplaySessionCard session={session} /> : <TwinSessionCard session={session} />;
}

type Panel = "report" | "transcript";

/**
 * The session card's frame: the top opens the session page; the footer holds the status on the left and, on the
 * right, toggles that open the report details or the transcript the copilot read, in place (the card grows; the
 * conversation doesn't jump to another page).
 */
function SessionFrame({ href, label, head, children, status, panels, open, onOpen }: {
  href: Route;
  label: string;
  head: React.ReactNode;
  children?: React.ReactNode;
  status: React.ReactNode;
  panels: { id: Panel; label: string; content: React.ReactNode }[];
  open: Panel | null;
  onOpen: (panel: Panel | null) => void;
}) {
  const current = panels.find((panel) => panel.id === open);
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-tt-md border border-(--card-border) bg-card shadow-elevation-1 transition-shadow duration-200 has-[a:hover]:shadow-elevation-2">
      <Link href={href} aria-label={label} className="group/card flex flex-col gap-2.5 p-3 pb-2.5 outline-none focus-visible:bg-muted/50">
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">{head}</span>
          <ArrowUpRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5 group-hover/card:text-foreground motion-reduce:transition-none" />
        </span>
        {children}
      </Link>
      <div className="flex min-h-10 items-center justify-between gap-2 border-t border-(--card-border) px-3 py-1.5">
        <span className="min-w-0">{status}</span>
        {panels.length ? (
          <span className="flex shrink-0 gap-0.5" role="group" aria-label="Show more of this session">
            {panels.map((panel) => (
              <button
                key={panel.id}
                type="button"
                aria-expanded={open === panel.id}
                onClick={() => onOpen(open === panel.id ? null : panel.id)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  open === panel.id && "bg-muted text-foreground",
                )}
              >
                {panel.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {current ? (
        <div key={current.id} className="animate-copilot-chip border-t border-(--card-border) bg-(--sidebar) px-3 py-3">
          {current.content}
        </div>
      ) : null}
    </article>
  );
}

/** The turns the copilot read, numbered as it cites them ("turn 12"), in a short scrolling well. */
function TranscriptExcerpt({ transcript, href }: { transcript: NonNullable<ReadSession["transcript"]>; href: Route }) {
  const first = transcript.turns[0]?.n ?? transcript.fromTurn;
  const last = transcript.turns.at(-1)?.n ?? first;
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain">
        {transcript.turns.map((turn) => {
          const learner = turn.speaker === "learner";
          return (
            <li key={turn.n} className={cn("flex gap-2", learner && "flex-row-reverse")}>
              <span className="w-6 shrink-0 pt-1.5 text-center text-xs text-muted-foreground tabular-nums" aria-label={`Turn ${turn.n}`}>{turn.n}</span>
              <p className={cn("max-w-[85%] rounded-tt-md px-2.5 py-1.5 text-body-s leading-body-s whitespace-pre-wrap", learner ? "bg-(--brand)/10" : "bg-card")}>
                {turn.text}
              </p>
            </li>
          );
        })}
      </ol>
      <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {transcript.turns.length ? `Turns ${first}–${last} of ${transcript.totalTurns}` : "No transcript was saved"}
        </span>
        <Link href={href} className="rounded-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Full transcript</Link>
      </span>
    </div>
  );
}

const GOAL = {
  met: { label: "Met", tone: "success" },
  partly: { label: "Partly", tone: "warning" },
  not_met: { label: "Missed", tone: "secondary" },
} as const;

/** A role play's report in brief: goals, the rubric as bars, and the biggest opportunity (as on its report page). */
function RoleplayReportDetails({ report }: { report: NonNullable<RoleplayOutputs["sessions"]["get"]["report"]> }) {
  const rubric = report.rubricScores ?? [];
  const earned = rubric.reduce((sum, row) => sum + row.points, 0);
  const total = rubric.reduce((sum, row) => sum + row.maxPoints, 0);
  return (
    <div className="flex flex-col gap-4">
      {report.goalResults?.length ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">Learner goals</h4>
          <ul className="flex flex-col gap-2">
            {report.goalResults.map((goal) => (
              <li key={goal.goal} className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-body-s leading-body-s">{goal.goal}</span>
                  {goal.evidence ? <span className="text-xs text-muted-foreground">{goal.evidence}</span> : null}
                </span>
                <Badge variant={GOAL[goal.status].tone}>{GOAL[goal.status].label}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {rubric.length ? (
        <section className="flex flex-col gap-2">
          <h4 className="flex items-baseline justify-between text-xs font-medium text-muted-foreground">
            Scoring rubric <span className="tabular-nums"><b className="text-foreground">{earned}</b> / {total}</span>
          </h4>
          <ul className="flex flex-col gap-2.5">
            {rubric.map((row) => (
              <li key={row.criterion} title={row.reason}>
                <Progress value={row.maxPoints ? Math.round((row.points / row.maxPoints) * 100) : 0}>
                  <ProgressLabel className="min-w-0 flex-1 basis-0 truncate font-normal">{row.criterion}</ProgressLabel>
                  <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">{row.points} / {row.maxPoints}</span>
                </Progress>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.focusNextTime ? (
        <p className="rounded-tt-md bg-card p-2.5 text-body-s leading-body-s">
          <b>Biggest opportunity:</b> {report.focusNextTime}
        </p>
      ) : null}
    </div>
  );
}

/** A twin session's report in brief: what it couldn't answer, and the learner's own words about it. */
function TwinReportDetails({ unanswered, feedback }: { unanswered: string[]; feedback: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      {unanswered.length ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">Questions it couldn’t answer</h4>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-body-s leading-body-s marker:text-caution">
            {unanswered.map((question) => <li key={question}>{question}</li>)}
          </ul>
        </section>
      ) : null}
      {feedback ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Learner feedback</h4>
          <p className="text-body-s leading-body-s text-(--text-secondary)">“{feedback}”</p>
        </section>
      ) : null}
    </div>
  );
}

const readLength = (read: ReadSession) => (read.minutes === null ? null : `${Math.max(1, Math.round(read.minutes))} min`);

function TwinSessionCard({ session: read }: { session: ReadSession }) {
  const [open, setOpen] = useState<Panel | null>(null);
  const { data, isPending } = useQuery({
    queryKey: ["copilot.cards.twin-session", read.id],
    queryFn: () => api.twin.sessions.get.query({ id: read.id }),
    staleTime: STALE,
    retry: false,
  });
  if (isPending) return <CardSkeleton />;
  const href = sessionHref(read.kind, read.id);
  const learner = shownName(data?.learner ?? read.learner);
  const topics = data?.topics ?? read.tags ?? [];
  const unanswered = data?.unanswered ?? [];
  const feedback = data?.feedbackNote?.trim() || read.learnerFeedback || null;
  const rating = data?.rating ?? read.learnerRating ?? null;
  return (
    <SessionFrame
      href={href}
      label={`Open the session with ${learner}`}
      head={
        <SessionHead
          learner={learner}
          context={<>{read.kind === "bot" ? "Website bot: " : "with "}{data?.agentName ?? read.agent.name}</>}
          at={data?.at ?? read.startedAt}
          length={data ? lengthOf(data.seconds) : readLength(read)}
        />
      }
      status={
        <span className="flex flex-col gap-0.5">
          {rating ? <HelpfulStars score={rating} /> : <span className="text-xs text-muted-foreground">Not rated yet</span>}
          {unanswered.length ? (
            <span className="text-xs text-caution">{unanswered.length === 1 ? "1 question it couldn't answer" : `${unanswered.length} questions it couldn't answer`}</span>
          ) : null}
        </span>
      }
      panels={[
        ...(unanswered.length || feedback ? [{ id: "report" as const, label: "Report", content: <TwinReportDetails unanswered={unanswered} feedback={feedback} /> }] : []),
        ...(read.transcript ? [{ id: "transcript" as const, label: "Transcript", content: <TranscriptExcerpt transcript={read.transcript} href={href} /> }] : []),
      ]}
      open={open}
      onOpen={setOpen}
    >
      {topics.length ? (
        <span className="flex flex-wrap gap-1.5">
          {topics.slice(0, 3).map((topic) => <Badge key={topic} variant="outline">{topic}</Badge>)}
          {topics.length > 3 ? <Badge variant="outline">+{topics.length - 3}</Badge> : null}
        </span>
      ) : null}
    </SessionFrame>
  );
}

function RoleplaySessionCard({ session: read }: { session: ReadSession }) {
  const [open, setOpen] = useState<Panel | null>(null);
  const { data, isPending } = useQuery({
    queryKey: ["copilot.cards.roleplay-session", read.id],
    queryFn: () => api.roleplay.sessions.get.query({ id: read.id }),
    staleTime: STALE,
    retry: false,
  });
  if (isPending) return <CardSkeleton />;
  const href = sessionHref("roleplay", read.id);
  const learner = shownName(data?.learner.name ?? read.learner);
  const score = data?.score ?? read.score ?? null;
  const report = data?.report ?? null;
  const hasDetails = Boolean(report && (report.goalResults?.length || report.rubricScores?.length || report.focusNextTime));
  return (
    <SessionFrame
      href={href}
      label={`Open the report for ${learner}`}
      head={
        <SessionHead
          learner={learner}
          image={data?.learner.image}
          context={<>{data?.roleplay.name ?? read.agent.name}{data?.client.name ? ` · with ${data.client.name}` : ""}</>}
          at={data?.at ?? read.startedAt}
          length={data ? lengthOf(data.seconds) : readLength(read)}
        />
      }
      status={
        score !== null ? (
          <Badge variant={scoreTone(score)}><span className="tabular-nums">Score {score}</span></Badge>
        ) : data?.reportState === "pending" ? (
          <span className="text-xs text-muted-foreground">Preparing report…</span>
        ) : null
      }
      panels={[
        ...(report && hasDetails ? [{ id: "report" as const, label: "Report", content: <RoleplayReportDetails report={report} /> }] : []),
        ...(read.transcript ? [{ id: "transcript" as const, label: "Transcript", content: <TranscriptExcerpt transcript={read.transcript} href={href} /> }] : []),
      ]}
      open={open}
      onOpen={setOpen}
    >
      {report?.summary ? <span className="line-clamp-3 text-body-s leading-body-s text-(--text-secondary)">{report.summary}</span> : null}
    </SessionFrame>
  );
}
