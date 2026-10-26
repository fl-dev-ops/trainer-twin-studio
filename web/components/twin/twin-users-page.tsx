import { UsersIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

const TWIN_LEARNERS = [
  { name: "Aisha Khan", email: "aisha.khan@gmail.com", agents: 4, minutes: 240, used: 168 },
  { name: "James Carter", email: "james.carter@outlook.com", agents: 3, minutes: 180, used: 74 },
  { name: "Nora Ali", email: "nora.ali@gmail.com", agents: 2, minutes: 120, used: 112 },
  { name: "Leo Martin", email: "leo@martinrealty.ae", agents: 3, minutes: 180, used: 31 },
  { name: "Priya Nair", email: "priya.nair@gmail.com", agents: 4, minutes: 240, used: 205 },
  { name: "Omar Haddad", email: "omar.haddad@dubaihomes.com", agents: 2, minutes: 120, used: 48 },
  { name: "Sofia Rossi", email: "sofia.rossi@gmail.com", agents: 3, minutes: 180, used: 96 },
  { name: "Daniel Cho", email: "daniel.cho@outlook.com", agents: 2, minutes: 120, used: 12 },
];

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

export function TwinUsersPage() {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1024px] px-4 md:px-0 pt-5 pb-16">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <h1 className="m-0 flex items-center gap-2 text-[16px] font-semibold leading-[22px] tracking-[-0.015em]">
            <span className="grid size-7 place-items-center rounded-[8px] text-(--text-secondary)">
              <UsersIcon className="size-[18px]" />
            </span>
            Twin users
          </h1>
        </header>

        <div className="mt-10">
          <h2 className="m-0 text-[18px] font-semibold leading-6 tracking-[-0.015em]">All learners</h2>
          <p className="mt-1 text-sm text-muted-foreground">People who can learn from your twins</p>
        </div>

        {/* Reference lr-table */}
        <div className="mt-4 overflow-hidden rounded-[16px] border border-(--card-border) bg-card shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
          {/* Header row */}
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_120px_130px_minmax(0,1.3fr)] items-center gap-3 bg-(--sidebar) px-5 py-2.5 text-[12px] font-medium tracking-[0.04em] uppercase text-(--text-secondary)">
            <span>Learner</span>
            <span>Email</span>
            <span>Assigned agents</span>
            <span>Assigned minutes</span>
            <span>Usage (minutes)</span>
          </div>

          {/* Rows */}
          {TWIN_LEARNERS.map((l, i) => {
            const left = l.minutes - l.used;
            const pct = Math.round((l.used / l.minutes) * 100);
            const isHigh = pct >= 90;
            return (
              <div
                key={l.email}
                className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_120px_130px_minmax(0,1.3fr)] items-center gap-3 border-t border-(--border) px-5 py-3.5 text-sm"
              >
                <span className="flex items-center gap-3 min-w-0 font-medium">
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
                      AVATAR_TONES[i % AVATAR_TONES.length],
                    )}
                    aria-hidden
                  >
                    {l.name.charAt(0)}
                  </span>
                  <span className="truncate">{l.name}</span>
                </span>

                <span className="truncate text-muted-foreground">{l.email}</span>

                <span className="tabular-nums">
                  {l.agents} <span className="text-muted-foreground font-normal">agents</span>
                </span>

                <span className="tabular-nums">
                  {l.minutes} <span className="text-muted-foreground font-normal">min</span>
                </span>

                <span className="flex flex-col gap-1.5 min-w-0">
                  <span className="block h-1.5 w-full overflow-hidden rounded-full bg-(--tone-control)">
                    <span
                      className={cn(
                        "block h-full rounded-full transition-all",
                        isHigh ? "bg-amber-600 dark:bg-amber-500" : "bg-(--foreground)",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="text-[13px] leading-[18px] text-muted-foreground tabular-nums">
                    {l.used} used · {left} left
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
