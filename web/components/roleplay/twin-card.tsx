"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ScenarioMenu, type ScenarioCardData } from "@/components/roleplay/scenario-card";
import { UserAvatar, UserAvatarGroup } from "@/components/user-avatar";

const noopSubscribe = () => () => {};
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "2 days ago", "yesterday", "5 minutes ago". */
export function updatedAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  return "just now";
}

/** The trainer's twin, as the prototype's wide "Twin for all use cases" card. */
export function TwinCard({ twin }: { twin: ScenarioCardData }) {
  const href = `/agents/${encodeURIComponent(twin.slug)}`;
  // Relative time is formatted on the client only, so server and client render the same markup.
  const updated = useSyncExternalStore(noopSubscribe, () => (twin.updatedAt ? updatedAgo(twin.updatedAt) : ""), () => "");

  return (
    <article className="group relative flex items-center gap-3 rounded-2xl border bg-card p-4 shadow-[0_1px_2px_rgba(30,28,25,0.04)] transition-shadow focus-within:ring-3 focus-within:ring-ring/50 hover:shadow-md">
      {/* 40px, the size a persona gets in the scenario cards. */}
      <UserAvatar user={{ name: twin.personaName ?? twin.name }} size="xl" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="text-[15px] leading-[22px] font-semibold">
          <Link href={href} className="outline-none after:absolute after:inset-0 after:rounded-2xl">
            {twin.name}
          </Link>
        </h3>
        <p className="min-h-5 text-[13px] leading-5 text-muted-foreground">{updated ? `Last updated ${updated}` : "\u00a0"}</p>
      </div>
      {twin.learners?.length ? (
        <UserAvatarGroup users={twin.learners} max={4} size="sm" />
      ) : (
        <span className="text-xs text-muted-foreground">No learners assigned</span>
      )}
      <ScenarioMenu scenario={twin} />
    </article>
  );
}
