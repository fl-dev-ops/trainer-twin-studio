"use client";

import Link from "next/link";
import { useState } from "react";
import { BarChart3, Pencil, Play, Search, UserPlus } from "lucide-react";
import { RoleplayIcon } from "@/components/icons";
import { DotsIcon, GRADIENTS, LearnerAvatars } from "@/components/library-card-parts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

type Scenario = RoleplayOutputs["scenarios"]["list"][number];

/** Actions of one role play (card menu and detail header share them). */
export function RoleplayMenu({ slug, name, trigger }: { slug: string; name: string; trigger?: "card" | "header" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Actions for ${name}`}
            className={cn(
              "grid size-8 place-items-center rounded-full text-(--foreground) transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--brand)",
              trigger === "header" ? "bg-(--tone-control) hover:bg-(--border)" : "ml-auto hover:bg-(--tone-control)",
            )}
          >
            <DotsIcon />
          </button>
        }
      />
      <DropdownMenuContent side="bottom" align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href={`/roleplay/${slug}/edit`} />}>
            <Pencil className="size-4" />
            <span>Edit</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={`/talk?agent=${encodeURIComponent(slug)}`} />}>
            <Play className="size-4" />
            <span>Try as learner</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={`/roleplay/${slug}/assign`} />}>
            <UserPlus className="size-4" />
            <span>Assign</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={`/roleplay/${slug}`} />}>
            <BarChart3 className="size-4" />
            <span>Sessions</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One role play (reference rp-card): the client's opening line on the art, title, brief, learners, actions. */
function ScenarioCard({ scenario, index }: { scenario: Scenario; index: number }) {
  return (
    <article className="flex flex-col overflow-visible rounded-[12px] border border-(--card-border) bg-card text-left shadow-[0_1px_2px_rgb(30_28_25/0.04)] transition-shadow hover:shadow-[0_2px_4px_rgb(30_28_25/0.07),0_8px_20px_rgb(30_28_25/0.11)]">
      <Link href={`/roleplay/${scenario.slug}`} className="block outline-none">
        <div className={cn("relative flex min-h-[176px] items-center justify-center rounded-t-[12px] p-4", GRADIENTS[index % GRADIENTS.length])}>
          <div className="relative w-full rounded-[12px] bg-card p-3.5 shadow-[0_2px_8px_rgb(0_0_0/0.08)]">
            <span className="absolute top-full right-3 left-3 -z-10 -mt-2 h-4 rounded-b-[12px] bg-[rgb(255_255_255/0.28)] dark:bg-[rgb(0_0_0/0.25)]" />
            <div className="flex items-center gap-3">
              <UserAvatar user={{ name: scenario.client.name, image: scenario.client.photoUrl }} className="size-10 text-sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] leading-[18px] font-semibold text-(--foreground)">{scenario.client.name}</span>
                <span className="line-clamp-2 text-[13px] leading-[18px] text-(--text-secondary) dark:text-[#c4c4c4]" title={scenario.opening ?? undefined}>
                  {scenario.opening ? `“${scenario.opening}”` : scenario.client.role ?? "Client"}
                </span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-0">
          <span className="line-clamp-1 text-[15px] leading-[22px] font-semibold tracking-[-0.015em] text-(--foreground)" title={scenario.name}>
            {scenario.name}
          </span>
          {scenario.description ? (
            <span className="line-clamp-3 text-[13px] leading-5 text-(--text-secondary)" title={scenario.description}>
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
    ? scenarios.filter((s) => `${s.name} ${s.description ?? ""} ${s.client.name}`.toLowerCase().includes(q))
    : scenarios;
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 pt-5 pb-16 md:px-0">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <h1 className="m-0 flex items-center gap-2 text-[16px] leading-[22px] font-semibold tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <RoleplayIcon className="size-[18px]" />
            </span>
            Scenarios
          </h1>
          <div className="flex items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-full border border-(--card-border) bg-card px-3 text-[13px] text-muted-foreground focus-within:border-(--brand)">
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
              href="/roleplay/new"
              className="inline-flex h-8 items-center gap-2 rounded-full bg-(--brand) px-3.5 text-[13px] leading-5 font-medium text-white transition-colors hover:bg-[#e04d00] dark:hover:bg-[#ff7e33]"
            >
              <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
                <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
              </svg>
              New
            </Link>
          </div>
        </header>

        <h2 className="mt-10 text-[18px] leading-6 font-semibold tracking-[-0.015em]">Created role plays</h2>
        {shown.length ? (
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((scenario, i) => (
              <ScenarioCard key={scenario.slug} scenario={scenario} index={i} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            {q ? "No role plays match that search." : "No role plays yet. Create one with New."}
          </p>
        )}
      </div>
    </div>
  );
}
