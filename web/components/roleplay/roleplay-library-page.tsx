"use client";

import Link from "next/link";
import { useState } from "react";
import { AudioLines, BarChart3, Pencil, Play, Search, UserPlus } from "lucide-react";
import { RoleplayIcon } from "@/components/icons";
import { DotsIcon, GRADIENTS, LearnerAvatars } from "@/components/library-card-parts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar, UserAvatarGroup } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { dashRoute } from "@/lib/routes";

type Scenario = RoleplayOutputs["scenarios"]["list"][number];

/** Actions of one role play (card menu and detail header share them). */
export function RoleplayMenu({ slug, name, trigger }: { slug: string; name: string; trigger?: "card" | "header" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={trigger === "header" ? "secondary" : "ghost"}
            size="icon"
            className={trigger === "header" ? undefined : "ml-auto"}
            aria-label={`Actions for ${name}`}
          />
        }
      >
        <DotsIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem render={<Link href={dashRoute(`/roleplay/${slug}/edit`)} />}>
              <Pencil className="size-4" />
              <span>Edit</span>
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href={dashRoute(`/talk?agent=${encodeURIComponent(slug)}`)} />}>
              <Play className="size-4" />
              <span>Try as learner</span>
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href={dashRoute(`/roleplay/${slug}/assign`)} />}>
              <UserPlus className="size-4" />
              <span>Assign</span>
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href={dashRoute(`/roleplay/${slug}`)} />}>
              <BarChart3 className="size-4" />
              <span>Sessions</span>
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href={dashRoute(`/roleplay/${slug}/calibrate`)} />}>
              <AudioLines className="size-4" />
              <span>Calibrate</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Who can play this role play. One persona keeps the name; a pool must not collapse to the default. */
function PersonaFace({ scenario }: { scenario: Scenario }) {
  const people = scenario.personas.length ? scenario.personas : [scenario.client];
  if (people.length === 1) {
    return (
      <div className="flex items-center gap-3">
        <UserAvatar user={{ name: people[0].name, image: people[0].photoUrl }} size="xl" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body-s leading-body-s font-semibold text-(--foreground)">{people[0].name}</span>
          <span className="line-clamp-2 text-body-s leading-body-s text-(--text-secondary)">{people[0].role ?? "Client"}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center">
      <UserAvatarGroup users={people.map((person) => ({ name: person.name, image: person.photoUrl }))} max={4} size="md" />
    </div>
  );
}

/** One role play (reference rp-card): who can play it, title, brief, learners, actions. */
function ScenarioCard({ scenario, index }: { scenario: Scenario; index: number }) {
  return (
    <article className="flex flex-col overflow-visible rounded-tt-md border border-(--card-border) bg-card text-left shadow-elevation-1 transition-shadow hover:shadow-elevation-2">
      <Link href={scenario.href} className="block outline-none">
        <div className={cn("relative flex min-h-[176px] items-center justify-center rounded-t-tt-md p-4", GRADIENTS[index % GRADIENTS.length])}>
          <div className="relative w-full rounded-tt-md bg-card p-3.5 shadow-elevation-2">
            <span className="absolute top-full right-3 left-3 -z-10 -mt-2 h-4 rounded-b-tt-md bg-white/28 dark:bg-black/25" />
            <PersonaFace scenario={scenario} />
          </div>
        </div>
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-0">
          <span className="line-clamp-1 text-body leading-body font-semibold tracking-title text-(--foreground)" title={scenario.name}>
            {scenario.name}
          </span>
          {scenario.description ? (
            <span className="line-clamp-3 text-body-s leading-5 text-(--text-secondary)" title={scenario.description}>
              {scenario.description}
            </span>
          ) : null}
        </div>
      </Link>
      <div className="mt-auto flex items-center justify-between gap-2 px-4 pt-4 pb-4">
        <LearnerAvatars learners={scenario.learners} label="Learners assigned to this role play" />
        <RoleplayMenu slug={scenario.slug} name={scenario.name} />
      </div>
    </article>
  );
}

/** Scenarios: the role-play library (reference pageRoleplay), in the /twin style. */
export function RoleplayLibraryPage({ scenarios }: { scenarios: Scenario[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? scenarios.filter((s) => `${s.name} ${s.description ?? ""} ${s.personas.map((p) => p.name).join(" ")} ${s.client.name}`.toLowerCase().includes(q))
    : scenarios;
  const created = shown;
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <h1 className="m-0 flex items-center gap-2 text-page-title leading-page-title font-semibold tracking-title">
          <span className="grid size-7 place-items-center rounded-tt-sm text-(--text-secondary)">
            <RoleplayIcon className="size-[18px]" />
          </span>
          Scenarios
        </h1>
        <div className="flex items-center gap-2">
          <label className="flex h-8 items-center gap-2 rounded-full border border-(--card-border) bg-card px-3 text-body-s text-muted-foreground focus-within:border-(--brand)">
            <Search className="size-4" aria-hidden />
            <span className="sr-only">Search role plays</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search..."
              autoComplete="off"
              className="w-36 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <Link
            href={dashRoute("/roleplay/new")}
            className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-3.5 text-body-s leading-5 font-medium text-white transition-colors hover:bg-brand-hover"
          >
            <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            New
          </Link>
        </div>
      </header>

      <h2 className="mt-10 text-section-title leading-6 font-semibold tracking-title">Created role plays</h2>
      {created.length ? (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {created.map((scenario, i) => (
            <ScenarioCard key={scenario.slug} scenario={scenario} index={i} />
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          {q ? "No role plays match that search." : "No role plays yet. Create one with New."}
        </p>
      )}

    </PageContainer>
  );
}
