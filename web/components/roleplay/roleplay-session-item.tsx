import Link from "next/link";
import { SessionTime } from "@/components/sessions/session-time";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user-avatar";
import type { RoleplayOutputs } from "@/lib/roleplay/trpc";
import { cn } from "@/lib/utils";

/** One practice session on a role play (role-play tRPC `sessions.list` row). */
export type RoleplaySessionItemData = RoleplayOutputs["sessions"]["list"][number];

/** Score badge: 70+ passes (reference rr pass mark). Three-level scoring is green / neutral / red: only the poles carry hue. */
export const scoreTone = (score: number) => (score >= 70 ? "success" : score >= 50 ? "secondary" : "error") as "success" | "secondary" | "error";

export const minutesLabel = (seconds: number | null) => (seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min`);

/** Reference sess-row: initial avatar, learner, role play · when · length, score and summary. */
export function RoleplaySessionItem({ session, divider = false }: { session: RoleplaySessionItemData; divider?: boolean }) {
  const length = minutesLabel(session.seconds);
  return (
    <li className={cn(divider && "border-t border-(--border)")}>
      <Link
        href={session.href}
        className="grid w-full grid-cols-[40px_minmax(0,1fr)_28px] items-start gap-3.5 p-4 px-5 text-left transition-colors outline-none hover:bg-(--sidebar) focus-visible:bg-(--sidebar)"
      >
        <UserAvatar user={session.learner} size="xl" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-5 font-semibold text-(--foreground)">{session.learner.name}</span>
          <span className="text-body-s leading-body-s text-muted-foreground">
            {session.roleplay.name} · <SessionTime iso={session.at} />
            {length ? ` · ${length}` : ""}
          </span>
          {session.summary ? <span className="truncate text-body-s leading-body-s text-muted-foreground">{session.summary}</span> : null}
          <span className="mt-1 flex flex-wrap items-center gap-2">
            {session.score !== null ? (
              <Badge variant={scoreTone(session.score)}><span className="tabular-nums">Score {session.score}</span></Badge>
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
