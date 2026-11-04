import type { CSSProperties } from "react";
import { UsersIcon } from "@/components/icons";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/page-container";
import { UserAvatar } from "@/components/user-avatar";
import { AccessUntil } from "@/components/twin/access-until";

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
      <div className="mt-4 overflow-hidden rounded-tt-lg border border-(--card-border) bg-card shadow-card">
        {/* Header row */}
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_110px_120px_130px_minmax(0,1.3fr)] items-center gap-3 bg-(--sidebar) px-5 py-2.5 text-overline font-medium tracking-overline uppercase text-(--text-secondary)">
          <span>Learner</span>
          <span>Email</span>
          <span>Assigned agents</span>
          <span>Assigned minutes</span>
          <span>Until</span>
          <span>Usage (minutes)</span>
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
            <div
              key={l.email}
              className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_110px_120px_130px_minmax(0,1.3fr)] items-center gap-3 border-t border-(--border) px-5 py-3.5 text-sm"
            >
              <span className="flex items-center gap-3 min-w-0 font-medium">
                <UserAvatar user={l} size="sm" />
                <span className="truncate">{l.name}</span>
              </span>

              <span className="truncate text-muted-foreground">{l.email}</span>

              <span className="tabular-nums">
                {l.agents} <span className="text-muted-foreground font-normal">agents</span>
              </span>

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
                <span className="text-body-s leading-body-s text-muted-foreground tabular-nums">
                  {l.used} used · {left} left
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </PageContainer>
  );
}
