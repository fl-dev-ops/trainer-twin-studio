"use client";

import Link from "next/link";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

type SessionDetailData = {
  id: string;
  learner: string;
  bot: string;
  when: string;
  duration: string;
  score: number;
  feedbackComment: string;
  topics: string[];
  turns: {
    who: "learner" | "twin";
    name: string;
    text: string;
    rated?: "like" | "off";
  }[];
};

const MOCK_SESSION_DETAILS: Record<string, SessionDetailData> = {
  "sess-1": {
    id: "sess-1",
    learner: "Aisha",
    bot: "The off-plan sales process",
    when: "Today, 2:14 pm",
    duration: "6 min",
    score: 9,
    feedbackComment: "Answered exactly what I was stuck on. Clear structure for the Zoom call.",
    topics: ["Off-plan qualification", "First call framework", "Next step commitment"],
    turns: [
      {
        who: "learner",
        name: "Aisha",
        text: "I need a structure, step by step.",
      },
      {
        who: "twin",
        name: "Olga’s twin",
        text: "First call books the educational Zoom, Zoom qualifies and books the presentation meeting. Every stage has one single goal: book the next step without forcing a premature decision.",
        rated: "like",
      },
      {
        who: "learner",
        name: "Aisha",
        text: "What if the buyer insists on discussing prices right away on that first call?",
      },
      {
        who: "twin",
        name: "Olga’s twin",
        text: "I wouldn’t quote numbers in the dark. Tell them prices depend entirely on the unit tier, view, and payment plan. Suggest a 15-minute Zoom where you can put two concrete layouts on screen.",
        rated: "like",
      },
      {
        who: "learner",
        name: "Aisha",
        text: "Understood. That makes complete sense.",
      },
    ],
  },
};

const DEFAULT_SESSION: SessionDetailData = MOCK_SESSION_DETAILS["sess-1"];

export function TwinSessionDetailPage({ id }: { id: string }) {
  const session = MOCK_SESSION_DETAILS[id] || {
    ...DEFAULT_SESSION,
    id,
  };

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[800px] px-4 md:px-0 pt-5 pb-16">
        {/* Back navigation */}
        <header className="flex min-h-10 items-center justify-between gap-4">
          <Link
            href="/twin/sessions"
            className="inline-flex items-center gap-2 text-sm text-(--text-secondary) hover:text-(--foreground) transition-colors"
          >
            <ArrowLeft className="size-4" />
            <span>Twin sessions</span>
          </Link>
        </header>

        <div className="mt-6 flex flex-col gap-4">
          {/* Header Card (sr-head) */}
          <article className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <div className="flex items-center gap-4 min-w-0">
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-base font-semibold text-emerald-600 dark:text-emerald-400">
                {session.learner.charAt(0)}
              </span>
              <div className="flex flex-col min-w-0">
                <h1 className="m-0 text-xl font-semibold leading-7">{session.learner}</h1>
                <p className="mt-0.5 text-sm font-medium text-(--foreground)">{session.bot}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {session.when} · {session.duration}
                </p>
              </div>
            </div>

            {/* Video preview */}
            <div className="flex flex-col gap-1.5 shrink-0 sm:w-60">
              <video
                src="/media/twin-listening.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                className="w-full aspect-video rounded-[12px] bg-(--sidebar) object-cover"
              />
              <span className="text-[11px] text-muted-foreground text-center sm:text-left">
                Recording · {session.duration}
              </span>
            </div>
          </article>

          {/* Feedback Card */}
          <article className="rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <div className="flex items-center justify-between gap-4">
              <h2 className="m-0 text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">
                Learner feedback
              </h2>
              <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                Helpful {session.score}/10
              </span>
            </div>
            <p className="mt-3 text-sm italic text-(--text-secondary)">“{session.feedbackComment}”</p>
          </article>

          {/* Topics Card */}
          <article className="rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <h2 className="m-0 text-sm font-semibold uppercase tracking-[0.04em] text-muted-foreground">
              Topics discussed
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {session.topics.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-(--sidebar) border border-(--border) px-3 py-1 text-xs font-medium text-(--text-secondary)"
                >
                  {t}
                </span>
              ))}
            </div>
          </article>

          {/* Transcript Card (rp-chat) */}
          <article className="rounded-[16px] border border-(--card-border) bg-card p-6 shadow-[0_2px_4px_rgb(30_28_25/0.035),0_8px_20px_rgb(30_28_25/0.055)]">
            <div className="flex items-center justify-between gap-4 border-b border-(--border) pb-4">
              <h2 className="m-0 text-base font-semibold">Transcript</h2>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                Rated “Feels like me”
              </span>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              {session.turns.map((turn, i) => {
                const isTwin = turn.who === "twin";
                return (
                  <div
                    key={i}
                    className={cn(
                      "flex flex-col gap-1 max-w-[85%] rounded-[14px] p-4 text-sm leading-6",
                      isTwin
                        ? "self-start bg-(--sidebar) text-(--foreground)"
                        : "self-end bg-(--brand) text-white font-normal",
                    )}
                  >
                    <span
                      className={cn(
                        "text-xs font-semibold",
                        isTwin ? "text-muted-foreground" : "text-white/80",
                      )}
                    >
                      {turn.name}
                    </span>
                    <p className="m-0">{turn.text}</p>
                    {turn.rated === "like" && isTwin && (
                      <span className="mt-2 inline-flex items-center gap-1 self-start rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="size-3" /> Feels like me
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}
