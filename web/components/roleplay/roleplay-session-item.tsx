import Link from "next/link";
import { SessionTime } from "@/components/sessions/session-time";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

/** One practice session on a role play (role-play tRPC `sessions.list` row). */
export type RoleplaySessionItemData = RoleplayOutputs["sessions"]["list"][number];

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

/** Score chip tone: 70+ passes (reference rr pass mark). */
export const scoreTone = (score: number) =>
  score >= 70 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : score >= 50 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-rose-500/15 text-rose-600 dark:text-rose-400";

export const minutesLabel = (seconds: number | null) => (seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min`);

/** Reference sess-row: initial avatar, learner, role play · when · length, score and summary. */
export function RoleplaySessionItem({ session, index = 0, divider = false }: { session: RoleplaySessionItemData; index?: number; divider?: boolean }) {
  const length = minutesLabel(session.seconds);
  return (
    <li className={cn(divider && "border-t border-(--border)")}>
      <Link
        href={session.href}
        className="grid w-full grid-cols-[40px_minmax(0,1fr)_28px] items-start gap-3.5 p-4 px-5 text-left transition-colors outline-none hover:bg-(--sidebar) focus-visible:bg-(--sidebar)"
      >
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold", AVATAR_TONES[index % AVATAR_TONES.length])} aria-hidden>
          {session.learner.name.charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-5 font-semibold text-(--foreground)">{session.learner.name}</span>
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            {session.roleplay.name} · <SessionTime iso={session.at} />
            {length ? ` · ${length}` : ""}
          </span>
          {session.summary ? <span className="truncate text-[13px] leading-[18px] text-muted-foreground">{session.summary}</span> : null}
          <span className="mt-1 flex flex-wrap items-center gap-2">
            {session.score !== null ? (
              <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums", scoreTone(session.score))}>Score {session.score}</span>
            ) : session.reportState === "pending" ? (
              <span className="text-xs text-muted-foreground">Preparing report…</span>
            ) : null}
          </span>
        </span>
        <span className="grid size-7 place-items-center self-center text-muted-foreground">
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden>
            <path d="M7 17 17 7M8 7h9v9" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </Link>
    </li>
  );
}
