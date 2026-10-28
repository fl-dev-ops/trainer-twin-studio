"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { LayoutGrid, List, MoreVertical, Pencil, Play, Plus, Search, UserRoundCheck } from "lucide-react";
import { useOrgCopy } from "@/components/org-type-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ScenarioCard } from "@/lib/scenario-cards";

type View = "grid" | "list";
type Tab = "published" | "draft";

const VIEW_KEY = "tt.scenarios.view";
const VIEW_EVENT = "tt-scenarios-view";
let memoryView: View = "grid";

function readView(): View {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === "grid" || saved === "list") return saved;
  } catch {
    // Storage unavailable: use the in-memory choice.
  }
  return memoryView;
}

function storeView(next: View) {
  try {
    window.localStorage.setItem(VIEW_KEY, next);
  } catch {
    // Storage unavailable: fall back to the in-memory choice.
  }
  memoryView = next;
  window.dispatchEvent(new Event(VIEW_EVENT));
}

function subscribeView(onChange: () => void) {
  window.addEventListener(VIEW_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(VIEW_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Card header washes, cycled per card (prototype gradients). */
const WASHES = [
  "from-[#b9cdf2] via-[#d8c5ea] to-[#f2c8dc]",
  "from-[#a9e3cf] via-[#bcdde8] to-[#c6cff1]",
  "from-[#f6d3b8] via-[#f2c4cf] to-[#dcc6ee]",
];

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function Avatar({ name, src, className }: { name: string; src?: string; className?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn("rounded-full object-cover", className)} />
  ) : (
    <span className={cn("grid place-items-center rounded-full bg-control text-[10px] font-semibold text-text-secondary", className)}>
      {initials(name)}
    </span>
  );
}

export function ScenarioList({ cards, onNew, actions }: {
  cards: ScenarioCard[];
  onNew: () => void;
  actions?: React.ReactNode;
}) {
  const copy = useOrgCopy();
  const [tab, setTab] = useState<Tab>("published");
  const view = useSyncExternalStore(subscribeView, readView, () => "grid" as View);
  const [query, setQuery] = useState("");

  const chooseView = storeView;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((card) => {
      const inTab = tab === "published" ? card.status === "published" : card.status === "draft" || Boolean(card.draftRevision);
      if (!inTab) return false;
      if (!q) return true;
      return [card.name, card.speaker, card.description, card.label, card.persona.name]
        .some((value) => value?.toLowerCase().includes(q));
    });
  }, [cards, tab, query]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <UserRoundCheck className="size-5 text-text-secondary" aria-hidden />
          <h1 className="text-base font-semibold">{copy.scenarios}</h1>
        </div>
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3.5 size-4 text-text-tertiary" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            aria-label={`Search ${copy.scenariosLower}`}
            className="h-10 w-52 rounded-full border border-input bg-card pr-4 pl-10 text-sm outline-none placeholder:text-text-muted hover:border-field-active focus-visible:border-field-active"
          />
        </label>
        {actions}
        <Button variant="secondary" className="h-10 rounded-full px-5" onClick={onNew}>
          <Plus data-icon="inline-start" /> {copy.newScenario}
        </Button>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg leading-6 font-semibold tracking-[-0.015em]">Created {copy.scenariosLower}</h2>
        <div className="flex items-center justify-between gap-3">
          <div role="tablist" aria-label={`${copy.scenario} status`} className="inline-flex rounded-full bg-sunken p-1">
            {(["published", "draft"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "rounded-full px-4 py-1.5 text-sm leading-5 font-medium transition-colors",
                  tab === value ? "bg-card text-foreground shadow-elevation-1" : "text-text-secondary hover:text-foreground",
                )}
              >
                {value === "published" ? "Published" : "Draft"}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Layout" className="inline-flex rounded-full bg-sunken p-1">
            {([
              ["grid", LayoutGrid, "Grid view"],
              ["list", List, "List view"],
            ] as const).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={view === value}
                aria-label={label}
                onClick={() => chooseView(value)}
                className={cn(
                  "grid h-8 w-10 place-items-center rounded-full transition-colors",
                  view === value ? "bg-card text-foreground shadow-elevation-1" : "text-text-secondary hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-card-border bg-card px-5 py-16 text-center shadow-card">
            <p className="text-sm font-medium">
              {query ? `No ${copy.scenariosLower} match your search` : tab === "published" ? `No published ${copy.scenariosLower} yet` : "No drafts"}
            </p>
            <p className="mt-1 text-sm text-text-tertiary">
              {query ? "Try another name or client." : `Create a ${copy.scenarioLower} to get started.`}
            </p>
          </div>
        ) : view === "grid" ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((card, index) => <ScenarioGridCard key={card.slug} card={card} wash={WASHES[index % WASHES.length]} />)}
          </div>
        ) : (
          <ScenarioTable cards={visible} />
        )}
      </section>
    </div>
  );
}

function ScenarioMenu({ card }: { card: ScenarioCard }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${card.name}`} />}
        onClick={(event) => event.preventDefault()}
      >
        <MoreVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem render={<Link href={`/agents/${encodeURIComponent(card.slug)}/edit`} />}>
          <Pencil /> Edit
        </DropdownMenuItem>
        {card.status === "published" && (
          <DropdownMenuItem render={<Link href={card.kind === "roleplay" ? `/talk?agent=${encodeURIComponent(card.slug)}` : `/agents/${encodeURIComponent(card.slug)}`} />}>
            <Play /> {card.kind === "roleplay" ? "Try role play" : "Open"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function href(card: ScenarioCard) {
  return card.status === "published"
    ? `/agents/${encodeURIComponent(card.slug)}`
    : `/agents/${encodeURIComponent(card.slug)}/edit`;
}

function ScenarioGridCard({ card, wash }: { card: ScenarioCard; wash: string }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-xl border border-card-border bg-card shadow-card transition-shadow hover:shadow-elevation-2">
      <Link href={href(card)} className="absolute inset-0 z-0" aria-label={card.name} />
      <div className={cn("bg-linear-to-br px-4 pt-4 pb-7 dark:opacity-90", wash)}>
        <p className="text-[11px] leading-4 font-medium tracking-[0.08em] text-text-secondary uppercase">{card.label}</p>
        <div className="relative mt-3">
          <div className="absolute inset-x-3 -bottom-2 h-6 rounded-xl bg-card/50" aria-hidden />
          <div className="relative flex gap-2.5 rounded-xl bg-card p-3 shadow-elevation-1">
            <Avatar name={card.speaker} src={card.speakerAvatar} className="size-6 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm leading-5 font-semibold">{card.speaker}</p>
              {card.quote && <p className="line-clamp-3 text-[13px] leading-[18px] text-text-secondary">&ldquo;{card.quote}&rdquo;</p>}
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-4 pt-4">
        <h3 className="text-[15px] leading-[22px] font-semibold tracking-[-0.015em]">{card.name}</h3>
        {card.description && <p className="line-clamp-2 text-[13px] leading-5 text-text-tertiary">{card.description}</p>}
      </div>
      <div className="relative z-10 mt-auto flex items-center justify-between px-4 pt-4 pb-3">
        <LearnerStack card={card} />
        <ScenarioMenu card={card} />
      </div>
    </article>
  );
}

function LearnerStack({ card }: { card: ScenarioCard }) {
  if (!card.learnerCount) {
    return <span className="text-xs text-text-tertiary">{card.status === "draft" ? "Draft" : "No sessions yet"}</span>;
  }
  const extra = card.learnerCount - card.learners.length;
  return (
    <div className="flex items-center -space-x-1.5" aria-label={`${card.learnerCount} learner${card.learnerCount === 1 ? "" : "s"}`}>
      {card.learners.map((learner) => (
        <span key={learner.name} title={learner.name} className="rounded-full ring-2 ring-card">
          <Avatar name={learner.name} src={learner.image} className="size-6" />
        </span>
      ))}
      {extra > 0 && (
        <span className="grid size-6 place-items-center rounded-full bg-control text-[10px] font-medium text-text-secondary ring-2 ring-card">
          +{extra}
        </span>
      )}
    </div>
  );
}

function ScenarioTable({ cards }: { cards: ScenarioCard[] }) {
  const copy = useOrgCopy();
  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card shadow-card">
      <table className="w-full min-w-[46rem] text-sm">
        <thead>
          <tr className="border-b text-left text-[13px] text-text-secondary">
            <th className="px-4 py-3 font-medium">{copy.scenario}</th>
            <th className="px-3 py-3 font-medium">Status</th>
            <th className="px-3 py-3 font-medium">Persona</th>
            <th className="px-3 py-3 text-right font-medium">Sessions</th>
            <th className="px-3 py-3 text-right font-medium">Avg score</th>
            <th className="px-3 py-3 font-medium">Last activity</th>
            <th className="w-12 px-2 py-3"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.slug} className="border-b last:border-b-0 hover:bg-[color-mix(in_srgb,var(--foreground)_2%,var(--card))]">
              <td className="max-w-72 px-4 py-4">
                <Link href={href(card)} className="font-semibold hover:text-brand-ink">{card.name}</Link>
                {card.description && <p className="truncate text-[13px] text-text-tertiary">{card.description}</p>}
              </td>
              <td className="px-3 py-4">
                <span className={cn(
                  "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium",
                  card.status === "published" ? "bg-[#edf9f1] text-[#1a6739] dark:bg-[#0e3e22] dark:text-[#7fd1a0]" : "bg-control text-text-secondary",
                )}>
                  {card.status === "published" ? (card.draftRevision ? "Active · draft" : "Active") : "Draft"}
                </span>
              </td>
              <td className="px-3 py-4">
                <div className="flex items-center gap-2">
                  <Avatar name={card.persona.name} src={card.persona.avatar} className="size-8" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px]">{card.persona.name}</p>
                    <p className="text-xs text-text-tertiary">{card.kind === "roleplay" ? "Client" : "Twin"}</p>
                  </div>
                </div>
              </td>
              <td className="px-3 py-4 text-right tabular-nums">{card.sessions}</td>
              <td className="px-3 py-4 text-right tabular-nums">{card.avgScore === null ? "—" : card.avgScore.toFixed(1)}</td>
              <td className="px-3 py-4 text-[13px] whitespace-nowrap">{relativeTime(card.lastActivity)}</td>
              <td className="px-2 py-4"><ScenarioMenu card={card} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
