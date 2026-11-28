"use client";

import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { GRADIENTS, LearnerAvatars } from "@/components/library-card-parts";
import { SessionTime } from "@/components/sessions/session-time";
import { scoreTone } from "@/components/roleplay/roleplay-session-item";
import { HelpfulStars } from "@/components/twin/twin-session-item";
import { TwinFace } from "@/components/twin/twin-face";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar, UserAvatarGroup } from "@/components/user-avatar";
import { api } from "@/lib/api";
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

/** "Open" with an arrow that nudges when the card is hovered: where a click takes you. */
function OpenHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground transition-colors group-hover/card:text-foreground">
      {children}
      <ArrowUpRight aria-hidden className="size-3.5 transition-transform duration-200 group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5 motion-reduce:transition-none" />
    </span>
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
        kind={item.kind}
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

/** What the copilot's session read says: the fallback card when the studio's own session view isn't available. */
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

/** A session, as its page shows it in brief: for a twin the rating, topics and what it couldn't answer; for a role play the score and the report's summary. */
export function SessionCard({ session }: { session: ReadSession }) {
  return session.kind === "roleplay" ? <RoleplaySessionCard session={session} /> : <TwinSessionCard session={session} />;
}

function TwinSessionCard({ session: read }: { session: ReadSession }) {
  const { data, isPending } = useQuery({
    queryKey: ["copilot.cards.twin-session", read.id],
    queryFn: () => api.twin.sessions.get.query({ id: read.id }),
    staleTime: STALE,
    retry: false,
  });
  if (isPending) return <CardSkeleton />;
  const topics = data?.topics ?? read.tags ?? [];
  const unanswered = data?.unanswered.length ?? 0;
  return (
    <CardLink href={sessionHref(read.kind, read.id)} label={`Open the session with ${shownName(data?.learner ?? read.learner)}`} className="flex-col gap-2.5 p-3">
      <SessionHead
        learner={shownName(data?.learner ?? read.learner)}
        context={<>{read.kind === "bot" ? "Website bot: " : "with "}{data?.agentName ?? read.agent.name}</>}
        at={data?.at ?? read.startedAt}
        length={data ? lengthOf(data.seconds) : read.minutes === null ? null : `${Math.max(1, Math.round(read.minutes))} min`}
      />
      {topics.length ? (
        <span className="flex flex-wrap gap-1.5">
          {topics.slice(0, 3).map((topic) => <Badge key={topic} variant="outline">{topic}</Badge>)}
          {topics.length > 3 ? <Badge variant="outline">+{topics.length - 3}</Badge> : null}
        </span>
      ) : null}
      <span className="flex items-end justify-between gap-3 border-t border-(--card-border) pt-2.5">
        <span className="flex flex-col gap-1">
          {(data?.rating ?? read.learnerRating) ? (
            <HelpfulStars score={data?.rating ?? read.learnerRating ?? null} />
          ) : (
            <span className="text-xs text-muted-foreground">Not rated yet</span>
          )}
          {unanswered ? (
            <span className="text-xs text-caution">{unanswered === 1 ? "1 question it couldn't answer" : `${unanswered} questions it couldn't answer`}</span>
          ) : null}
        </span>
        <OpenHint>Open session</OpenHint>
      </span>
    </CardLink>
  );
}

function RoleplaySessionCard({ session: read }: { session: ReadSession }) {
  const { data, isPending } = useQuery({
    queryKey: ["copilot.cards.roleplay-session", read.id],
    queryFn: () => api.roleplay.sessions.get.query({ id: read.id }),
    staleTime: STALE,
    retry: false,
  });
  if (isPending) return <CardSkeleton />;
  const score = data?.score ?? read.score ?? null;
  return (
    <CardLink href={sessionHref("roleplay", read.id)} label={`Open the report for ${shownName(data?.learner.name ?? read.learner)}`} className="flex-col gap-2.5 p-3">
      <SessionHead
        learner={shownName(data?.learner.name ?? read.learner)}
        image={data?.learner.image}
        context={<>{data?.roleplay.name ?? read.agent.name}{data?.client.name ? ` · with ${data.client.name}` : ""}</>}
        at={data?.at ?? read.startedAt}
        length={data ? lengthOf(data.seconds) : read.minutes === null ? null : `${Math.max(1, Math.round(read.minutes))} min`}
      />
      {data?.report?.summary ? (
        <span className="line-clamp-3 text-body-s leading-body-s text-(--text-secondary)">{data.report.summary}</span>
      ) : null}
      <span className="flex items-center justify-between gap-3 border-t border-(--card-border) pt-2.5">
        {score !== null ? (
          <Badge variant={scoreTone(score)}><span className="tabular-nums">Score {score}</span></Badge>
        ) : data?.reportState === "pending" ? (
          <span className="text-xs text-muted-foreground">Preparing report…</span>
        ) : <span />}
        <OpenHint>Open report</OpenHint>
      </span>
    </CardLink>
  );
}
