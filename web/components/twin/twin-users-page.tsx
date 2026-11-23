import type { CSSProperties } from "react";
import Link from "next/link";
import { LowCreditsBadge } from "@/components/credits/low-credits-badge";
import { UsersIcon } from "@/components/icons";
import { LOW_LEARNER_MINUTES } from "@/lib/minutes-config";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { UserAvatar } from "@/components/user-avatar";
import { AccessUntil } from "@/components/twin/access-until";
import { dashRoute } from "@/lib/routes";

export function TwinUsersPage({ learners }: { learners: TwinOutputs["users"]["list"] }) {
  return (
    <PageContainer>
      <header className="flex min-h-10 items-center justify-between gap-4">
        <h1 className="m-0 flex items-center gap-2 text-page-title font-semibold leading-page-title tracking-title">
          <span className="grid size-7 place-items-center rounded-tt-sm text-(--text-secondary)">
            <UsersIcon className="size-[18px]" />
          </span>
          Twin users
        </h1>
      </header>

      <div className="mt-10">
        <h2 className="m-0 text-section-title font-semibold leading-6 tracking-title">All learners</h2>
        <p className="mt-1 text-sm text-muted-foreground">People who can learn from your twins</p>
      </div>

      {/* Reference lr-table */}
      <div className="mt-4 overflow-x-auto rounded-tt-lg border border-(--card-border) bg-card shadow-card">
        {/* Header row */}
        <div className="grid min-w-[960px] grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_110px_80px_120px_130px_minmax(0,1.3fr)] items-center gap-3 bg-(--sidebar) px-5 py-2.5 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">
          <span>Learner</span>
          <span>Email</span>
          <span>Assigned agents</span>
          <span>Sessions</span>
          <span>Credits given</span>
          <span>Until</span>
          <span>Credits used</span>
        </div>

        {/* Rows */}
        {learners.length === 0 ? (
          <p className="border-t border-(--border) px-5 py-6 text-center text-sm text-muted-foreground">
            Nobody has twin access yet. Assign a twin or share its link.
          </p>
        ) : null}
        {learners.map((l) => {
          const left = Math.max(0, l.minutes - l.used);
          const pct = Math.min(100, Math.round((l.used / l.minutes) * 100));
          const isHigh = pct >= 90;
          return (
            <Link
              key={l.userId}
              href={dashRoute(`/users/${encodeURIComponent(l.userId)}`)}
              aria-label={`Open profile for ${l.name}`}
              className="grid min-w-[960px] grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_110px_80px_120px_130px_minmax(0,1.3fr)] items-center gap-3 border-t border-(--border) px-5 py-3.5 text-sm outline-none transition-colors hover:bg-sidebar focus-visible:bg-sidebar focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex items-center gap-3 min-w-0 font-medium">
                <UserAvatar user={l} size="sm" />
                <span className="truncate">{l.name}</span>
              </span>

              <span className="truncate text-muted-foreground">{l.email}</span>

              <span className="tabular-nums">
                {l.agents} <span className="text-muted-foreground font-normal">agents</span>
              </span>

              <span className="tabular-nums">{l.sessions}</span>

              <span className="tabular-nums">
                {l.minutes} <span className="text-muted-foreground font-normal">min</span>
              </span>

              <span className="text-muted-foreground">
                <AccessUntil until={l.until} none="No end date" />
              </span>

              <span className="flex flex-col gap-1.5 min-w-0">
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-(--tone-control)">
                  <span
                    className={cn(
                      "block h-full w-(--w) rounded-full transition-all",
                      isHigh ? "bg-caution" : "bg-foreground",
                    )}
                    style={{ "--w": `${pct}%` } as CSSProperties}
                  />
                </span>
                <span className="flex items-center gap-2 text-body-s leading-body-s text-muted-foreground tabular-nums">
                  {l.used} used · {left} left
                  {left < LOW_LEARNER_MINUTES ? <LowCreditsBadge /> : null}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </PageContainer>
  );
}
