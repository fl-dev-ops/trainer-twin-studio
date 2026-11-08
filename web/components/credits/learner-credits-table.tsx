import Link from "next/link";
import { LowCreditsBadge } from "@/components/credits/low-credits-badge";
import { UserAvatar } from "@/components/user-avatar";
import { LOW_LEARNER_MINUTES } from "@/lib/minutes-config";

export type LearnerCreditsRow = {
  email: string;
  userId: string | null;
  name: string | null;
  image: string | null;
  givenMinutes: number;
  usedMinutes: number;
  leftMinutes: number;
};

const GRID = "grid grid-cols-[minmax(0,1fr)_110px_110px_150px] items-center gap-3";
const min = (value: number) => (
  <>
    {value.toLocaleString()} <span className="font-normal text-muted-foreground">min</span>
  </>
);

/**
 * Each learner's credits in total: everything given to them, what their calls used, and what's left (lowest first).
 * A learner who has signed up opens their page, where more can be added.
 */
export function LearnerCreditsTable({ rows }: { rows: LearnerCreditsRow[] }) {
  return (
    <div className="overflow-hidden rounded-tt-lg border border-(--card-border) bg-card shadow-card">
      <div className={`${GRID} bg-(--sidebar) px-5 py-2.5 text-overline font-medium tracking-overline uppercase text-(--text-secondary)`}>
        <span>Learner</span>
        <span>Given</span>
        <span>Used</span>
        <span>Left</span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 border-t border-(--border) px-5 py-6 text-center text-sm text-muted-foreground">No learner has credits yet. They get theirs when you invite or assign them.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((row) => (
            <li key={row.email} className={`${GRID} relative border-t border-(--border) px-5 py-3 text-sm`}>
              <span className="flex min-w-0 items-center gap-3">
                <UserAvatar user={{ name: row.name ?? row.email, email: row.email, image: row.image }} size="sm" />
                <span className="flex min-w-0 flex-col">
                  {row.userId ? (
                    <Link href={`/users/${row.userId}`} className="truncate font-medium outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring">
                      {row.name || row.email}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">{row.email}</span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">{row.userId ? row.email : "Invite pending"}</span>
                </span>
              </span>
              <span className="tabular-nums">{min(row.givenMinutes)}</span>
              <span className="tabular-nums">{min(row.usedMinutes)}</span>
              <span className="flex items-center gap-2 font-medium tabular-nums">
                <span>{min(row.leftMinutes)}</span>
                {row.leftMinutes < LOW_LEARNER_MINUTES ? <LowCreditsBadge /> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
