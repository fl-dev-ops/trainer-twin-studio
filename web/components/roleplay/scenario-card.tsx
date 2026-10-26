"use client";

import Link from "next/link";
import { MoreVertical, Pencil, Play, SlidersHorizontal, SquareArrowOutUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatarGroup } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

export type ScenarioCardData = {
  slug: string;
  name: string;
  objective?: string;
  /** A real line from the persona, shown in the card's speech bubble. */
  quote?: string;
  personaName?: string;
  learners?: { email: string; name: string; image: string | null }[];
  status?: "draft" | "published";
  draftRevision?: number;
  /** A twin ("Ask Olga"): an open conversation over all of the persona's playbooks. */
  twin?: boolean;
  updatedAt?: string;
};

/** Scenario card, matching the V2 prototype's role-play card. */
export function ScenarioCard({ scenario }: { scenario: ScenarioCardData }) {
  const href = `/agents/${encodeURIComponent(scenario.slug)}`;
  const persona = scenario.personaName ?? "Trainer";
  const badge = scenario.status === "draft" ? "Draft" : scenario.draftRevision ? "Unpublished changes" : null;

  return (
    <article className="group relative flex flex-col rounded-2xl border bg-card shadow-[0_1px_2px_rgba(30,28,25,0.04)] transition-shadow focus-within:ring-3 focus-within:ring-ring/50 hover:shadow-md">
      {/* Prototype art: one light wash in both themes. */}
      <div className="relative isolate flex h-[168px] items-center rounded-t-2xl bg-[linear-gradient(135deg,#a8c6ec_0%,#d2c3e8_50%,#f1c6d7_100%)] px-4">
        {badge ? (
          <Badge variant="secondary" className="absolute top-3 right-3 bg-white/80 text-neutral-800">
            {badge}
          </Badge>
        ) : null}
        <div
          className={cn(
            "relative flex w-full items-center gap-2 rounded-xl bg-card p-3 text-[13px] leading-[18px] text-muted-foreground shadow-[0_2px_8px_rgba(0,0,0,0.08)]",
            // The second card peeking out under the bubble.
            "before:absolute before:inset-x-2.5 before:-bottom-2.5 before:top-1/2 before:-z-10 before:rounded-b-xl before:bg-card/30",
          )}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {persona.charAt(0).toUpperCase()}
          </span>
          <span className="line-clamp-2">{scenario.quote ? `“${scenario.quote}”` : `${persona} · role play`}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 pt-3.5">
        <h3 className="text-[15px] leading-[22px] font-semibold">
          {/* Stretched link: the whole card opens the scenario; the menu sits above it. */}
          <Link href={href} className="outline-none after:absolute after:inset-0 after:rounded-2xl">
            {scenario.name}
          </Link>
        </h3>
        <p className="line-clamp-3 text-[13px] leading-5 text-muted-foreground">
          {scenario.objective || "A guided conversational scenario."}
        </p>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 p-4">
        {scenario.learners?.length ? (
          <UserAvatarGroup users={scenario.learners} max={4} size="sm" />
        ) : (
          <span className="text-xs text-muted-foreground">No learners assigned</span>
        )}
        <ScenarioMenu scenario={scenario} />
      </div>
    </article>
  );
}

/** The card's ⋮ menu; it sits above the card's stretched link. */
export function ScenarioMenu({ scenario }: { scenario: ScenarioCardData }) {
  const href = `/agents/${encodeURIComponent(scenario.slug)}`;
  return (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative z-10 size-8 rounded-full"
                aria-label={`Actions for ${scenario.name}`}
              />
            }
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem render={<Link href={href} />}>
              <SquareArrowOutUpRight />
              Open
            </DropdownMenuItem>
            {/* A twin has no spec of its own: its playbooks are the persona's scenarios. */}
            {!scenario.twin ? (
              <DropdownMenuItem render={<Link href={`${href}/edit`} />}>
                <Pencil />
                Configure
              </DropdownMenuItem>
            ) : null}
            {scenario.status !== "draft" ? (
              <DropdownMenuItem render={<Link href={`${href}/calibrate`} />}>
                <SlidersHorizontal />
                Calibrate
              </DropdownMenuItem>
            ) : null}
            {scenario.status !== "draft" ? (
              <DropdownMenuItem render={<Link href={`/talk?agent=${encodeURIComponent(scenario.slug)}`} />}>
                <Play />
                Try as learner
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
  );
}
