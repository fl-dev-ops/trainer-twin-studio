import Link from "next/link";
import { cn } from "@/lib/utils";

export type TwinSessionItemData = {
  id: string;
  learner: string;
  bot: string;
  when: string;
  question: string;
  answer: string;
  score: number;
  issues?: number;
};

export const TWIN_SESSIONS_MOCK: TwinSessionItemData[] = [
  {
    id: "sess-1",
    learner: "Aisha",
    bot: "The off-plan sales process",
    when: "Today, 2:14 pm",
    question: "I need a structure, step by step.",
    answer: "First call books the educational Zoom, Zoom qualifies and books the presentation meeting.",
    score: 9,
    issues: 0,
  },
  {
    id: "sess-2",
    learner: "James",
    bot: "Handling client objections",
    when: "Yesterday, 11:02 am",
    question: "A buyer tells me prices will drop next year. What do I say?",
    answer: "I’d ask what they’ll do with the money while they wait, and put a year of rent next to the payment plan.",
    score: 8,
    issues: 0,
  },
  {
    id: "sess-3",
    learner: "Nora",
    bot: "Re-engaging clients who have gone quiet",
    when: "Yesterday, 4:40 pm",
    question: "My client went quiet after the viewing.",
    answer: "Send one specific detail from the property they liked, not a generic follow-up.",
    score: 6,
    issues: 1,
  },
  {
    id: "sess-4",
    learner: "Leo",
    bot: "The off-plan sales process",
    when: "Monday, 9:18 am",
    question: "How do I transition from the discovery call to the Zoom?",
    answer: "Reference their specific budget and say you’ve prepared three options to review on screen.",
    score: 9,
    issues: 0,
  },
  {
    id: "sess-5",
    learner: "Priya",
    bot: "Handling client objections",
    when: "Sunday, 6:05 pm",
    question: "A seller wants me to cut my fee to one percent.",
    answer: "Name the exact scope: photography, viewings, negotiation. Ask which part they’d like to skip.",
    score: 10,
    issues: 0,
  },
];

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
  const scoreTone =
    session.score >= 9
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : session.score >= 7
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
            {session.bot} · {session.when}
          </span>
          <span className="text-[13px] leading-[18px] text-muted-foreground truncate">
            “{session.question}” · {session.answer}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", scoreTone)}>
              Helpful {session.score}/10
            </span>
            {(session.issues ?? 0) > 0 && (
              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {session.issues} issue reported
              </span>
            )}
          </span>
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
