import Link from "next/link";
import { SessionTime } from "@/components/sessions/session-time";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

/** One learner conversation with a twin (twin tRPC `sessions.list` row). */
export type TwinSessionItemData = TwinOutputs["sessions"]["list"][number];

const AVATAR_TONES = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
];

export function TwinSessionItem({
  session,
  index = 0,
  divider = false,
  className,
}: {
  session: TwinSessionItemData;
  index?: number;
  divider?: boolean;
  className?: string;
}) {
  // Learner feedback is 1-5.
  const score = session.rating;
  const scoreTone =
    score === null
      ? ""
      : score >= 5
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : score >= 4
        ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
        : "bg-amber-500/15 text-amber-600 dark:text-amber-400";

  return (
    <li className={cn(divider && "border-t border-(--border)", className)}>
      <Link
        href={`/twin/sessions/${session.id}`}
        className="grid w-full grid-cols-[40px_minmax(0,1fr)_28px] items-start gap-3.5 p-4 px-5 text-left transition-colors hover:bg-(--sidebar) outline-none focus-visible:bg-(--sidebar)"
      >
        {/* Initial avatar */}
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold",
            AVATAR_TONES[index % AVATAR_TONES.length],
          )}
          aria-hidden
        >
          {session.learner.charAt(0)}
        </span>

        {/* Middle text */}
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold leading-5 text-(--foreground)">{session.learner}</span>
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            {session.agentName} · <SessionTime iso={session.at} />
          </span>
          {session.question ? (
            <span className="text-[13px] leading-[18px] text-muted-foreground truncate">
              “{session.question}”{session.answer ? ` · ${session.answer}` : ""}
            </span>
          ) : null}
          {score !== null ? (
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", scoreTone)}>
                Helpful {score}/5
              </span>
            </span>
          ) : null}
        </span>

        {/* Arrow action */}
        <span className="grid size-7 place-items-center self-center text-muted-foreground">
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden>
            <path d="M7 17 17 7M8 7h9v9" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </Link>
    </li>
  );
}
