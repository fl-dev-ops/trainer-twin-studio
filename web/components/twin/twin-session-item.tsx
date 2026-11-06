import Link from "next/link";
import { Star } from "lucide-react";
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

/** Grid shared by the column header row (twin-sessions-page) and the item rows. */
// sm+: avatar fixed, learner and topics take the flexible space, minutes/helpfulness columns fixed to their label widths.
export const TWIN_SESSION_GRID =
  "grid grid-cols-[40px_minmax(0,1fr)_28px] gap-x-3.5 sm:grid-cols-[40px_minmax(0,1fr)_minmax(0,0.9fr)_72px_112px_28px]";

// 5 green ("Very helpful"), 3-4 gold ("Helpful"), 1-2 red, as the prototype reads them.
const STAR_TONE = { success: "fill-(--color-success) text-(--color-success)", secondary: "fill-(--color-caution) text-(--color-caution)", error: "fill-(--color-danger) text-(--color-danger)" } as const;
const SCORE_LABEL = (score: number) => (score >= 5 ? "Very helpful" : score >= 4 ? "Helpful" : score >= 3 ? "Somewhat helpful" : "Not helpful");

/** The score as a 5-star row with the label under it; "–" when the learner did not rate. */
function HelpfulStars({ score }: { score: number | null }) {
  if (score === null || score === 0) return <span className="text-sm text-muted-foreground">–</span>;
  const tone = STAR_TONE[helpfulTone(score)];
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span className="flex" aria-label={`Rated ${score} out of 5`}>
        {[1, 2, 3, 4, 5].map((star) => (
          <Star key={star} size={14} aria-hidden className={cn("shrink-0", star <= score ? tone : "fill-muted text-muted-foreground/30")} />
        ))}
      </span>
      <span className="text-body-s text-muted-foreground">{SCORE_LABEL(score)}</span>
    </span>
  );
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
  // Minutes on the call (at least 1 once it started), as on the session page.
  const minutes = session.seconds === null ? null : Math.max(1, Math.round(session.seconds / 60));
  const scoreTone = score === null ? "secondary" : helpfulTone(score);

  return (
    <li className={cn(divider && "border-t border-border", className)}>
      <Link
        href={`/twin/sessions/${session.id}`}
        className={cn(
          TWIN_SESSION_GRID,
          "w-full items-center p-4 px-5 text-left transition-colors hover:bg-(--sidebar) outline-none focus-visible:bg-(--sidebar)",
        )}
      >
        <UserAvatar user={{ name: session.learner, email: session.learnerEmail }} size="xl" />

        {/* Learner */}
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold leading-5 text-(--foreground)">{session.learner}</span>
          <span className="text-body-s leading-body-s text-muted-foreground">
            <span className="sm:hidden">{session.agentName} · </span>
            <SessionTime iso={session.at} />
            {minutes ? <span className="sm:hidden"> · {minutes} min</span> : null}
          </span>
          {/* Small screens: the columns are hidden, so the score badge stays inline here. */}
          {score !== null && score > 0 ? (
            <span className="mt-1 sm:hidden">
              <Badge variant={scoreTone}>Helpful {score}/5</Badge>
            </span>
          ) : null}
        </span>

        {/* Topics: first two as chips, then a +n badge for the rest */}
        <span className="hidden flex-wrap items-center gap-1.5 overflow-hidden sm:flex">
          {session.topics.length ? (
            <>
              {session.topics.slice(0, 2).map((topic) => (
                <Badge key={topic} className="max-w-full truncate" variant="outline">
                  {topic}
                </Badge>
              ))}
              {session.topics.length > 2 ? <Badge className="shrink-0" variant="outline">+{session.topics.length - 2}</Badge> : null}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">–</span>
          )}
        </span>

        {/* Duration */}
        <span className="hidden text-sm text-(--foreground) sm:block">{minutes ? `${minutes} min` : "–"}</span>

        {/* Helpfulness */}
        <span className="hidden sm:block">
          <HelpfulStars score={score} />
        </span>

        {/* Arrow action */}
        <span className="grid size-7 place-items-center text-muted-foreground">
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden>
            <path d="M7 17 17 7M8 7h9v9" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </Link>
    </li>
  );
}
