import Link from "next/link";
import { SessionTime } from "@/components/sessions/session-time";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/user-avatar";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

/** Learner feedback is 1-5, read as three levels: green / neutral / red (only the poles carry hue). Means round first. */
export function helpfulTone(score: number) {
  const rounded = Math.round(score);
  return rounded >= 5 ? "success" : rounded >= 4 ? "secondary" : "error";
}

/** One learner conversation with a twin (twin tRPC `sessions.list` row). */
export type TwinSessionItemData = TwinOutputs["sessions"]["list"][number];

export function TwinSessionItem({
  session,
  divider = false,
  className,
}: {
  session: TwinSessionItemData;
  divider?: boolean;
  className?: string;
}) {
  const score = session.rating;
  const scoreTone = score === null ? "secondary" : helpfulTone(score);

  return (
    <li className={cn(divider && "border-t border-border", className)}>
      <Link
        href={`/twin/sessions/${session.id}`}
        className="grid w-full grid-cols-[40px_minmax(0,1fr)_28px] items-start gap-3.5 p-4 px-5 text-left transition-colors hover:bg-(--sidebar) outline-none focus-visible:bg-(--sidebar)"
      >
        <UserAvatar user={{ name: session.learner, email: session.learnerEmail }} size="xl" />

        {/* Middle text */}
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold leading-5 text-(--foreground)">{session.learner}</span>
          <span className="text-body-s leading-body-s text-muted-foreground">
            {session.agentName} · <SessionTime iso={session.at} />
          </span>
          {session.question ? (
            <span className="truncate text-body-s leading-body-s text-muted-foreground">
              “{session.question}”{session.answer ? ` · ${session.answer}` : ""}
            </span>
          ) : null}
          {score !== null ? (
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={scoreTone}>Helpful {score}/5</Badge>
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
