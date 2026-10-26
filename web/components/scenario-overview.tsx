import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ScenarioConversation = {
  id: string;
  learnerName: string;
  aiLine?: string;
  learnerLine?: string;
  score?: number;
  createdAt: string;
};

export type ScenarioOverviewData = {
  name: string;
  personaLabel: string;
  personaName: string;
  personaAvatar?: string;
  scenarioLabel: string;
  scenarioText?: string;
  aiName: string;
  /** Session counts for the last seven days, oldest first, with weekday labels. */
  week: { label: string; count: number }[];
  /** Scores of scored sessions, oldest first. */
  scores: number[];
  totalSessions: number;
  conversations: ScenarioConversation[];
};

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** Overview of one role play or scenario: what it is, how often it runs, and its conversations. */
export function ScenarioOverview({ data }: { data: ScenarioOverviewData }) {
  const weekMax = Math.max(1, ...data.week.map((day) => day.count));
  return (
    <div className="flex flex-col gap-6">
      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{data.name}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{data.personaLabel}</p>
              <div className="flex items-center gap-3">
                {data.personaAvatar ? (
                  // eslint-disable-next-line @next/next/no-img-element -- persona avatars are arbitrary uploaded URLs
                  <img src={data.personaAvatar} alt="" className="size-10 rounded-full object-cover" />
                ) : (
                  <span className="grid size-10 place-items-center rounded-full bg-muted text-sm font-semibold">{initial(data.personaName)}</span>
                )}
                <span className="text-lg font-semibold">{data.personaName}</span>
              </div>
            </div>
            {data.scenarioText ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{data.scenarioLabel}</p>
                <p className="text-sm leading-6 whitespace-pre-line">{data.scenarioText}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Report</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="w-fit min-w-32 rounded-xl bg-emerald-50 px-4 py-3.5 dark:bg-emerald-950/40">
              <p className="text-[11px] font-medium tracking-[0.08em] text-emerald-800 uppercase dark:text-emerald-300">Sessions</p>
              <p className="mt-1.5 text-2xl font-medium tabular-nums text-emerald-800 dark:text-emerald-300">{data.totalSessions}</p>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm">Sessions this week</p>
              <div className="flex flex-col gap-1" role="img"
                aria-label={data.week.map((day) => `${day.label} ${day.count}`).join(", ")}>
                <div className="flex h-9 items-end gap-1.5">
                  {data.week.map((day) => (
                    <span key={day.label}
                      className={day.count ? "flex-1 rounded-[3px] bg-[#2f62c4] dark:bg-[#5b8ae0]" : "flex-1 rounded-[3px] bg-[#2f62c4]/15 dark:bg-[#5b8ae0]/20"}
                      style={{ height: day.count ? `${Math.max(18, Math.round((day.count / weekMax) * 100))}%` : "3px" }} />
                  ))}
                </div>
                <div className="flex gap-1.5">
                  {data.week.map((day, index) => (
                    <span key={day.label}
                      className={index === data.week.length - 1 ? "flex-1 text-center text-[8px] text-orange-600" : "flex-1 text-center text-[8px] text-muted-foreground"}>
                      {day.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {data.scores.length > 1 ? <ScoreTrend scores={data.scores} /> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Conversations</CardTitle></CardHeader>
        <CardContent>
          {data.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversations yet. They appear here once learners start sessions.</p>
          ) : (
            <ul className="divide-y">
              {data.conversations.map((conversation) => (
                <li key={conversation.id}>
                  <Link href={`/sessions/${encodeURIComponent(conversation.id)}`}
                    className="flex items-center gap-4 py-4 hover:bg-muted/40 focus-visible:bg-muted/40 rounded-lg px-2 -mx-2">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold">
                      {initial(conversation.learnerName)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-semibold">{conversation.learnerName}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{conversation.createdAt}</span>
                      </span>
                      {conversation.aiLine ? (
                        <span className="truncate text-xs text-muted-foreground"><span className="font-medium text-foreground">{data.aiName}</span> {conversation.aiLine}</span>
                      ) : null}
                      {conversation.learnerLine ? (
                        <span className="truncate text-xs text-muted-foreground"><span className="font-medium text-foreground">{conversation.learnerName}</span> {conversation.learnerLine}</span>
                      ) : null}
                    </span>
                    {typeof conversation.score === "number" ? (
                      <span className="shrink-0 text-sm tabular-nums"><span className="text-base font-semibold">{conversation.score}</span> / 100</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ScoreTrend({ scores }: { scores: number[] }) {
  const width = 400;
  const height = 40;
  const pad = 8;
  const step = (width - pad * 2) / (scores.length - 1);
  const x = (index: number) => pad + index * step;
  const y = (score: number) => pad + (1 - Math.max(0, Math.min(100, score)) / 100) * (height - pad * 2);
  const points = scores.map((score, index) => `${x(index)},${y(score)}`).join(" ");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Session scores <span className="text-muted-foreground">(last {scores.length})</span></p>
      <div role="img" aria-label={`Scores out of 100, oldest first: ${scores.join(", ")}`}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-10 w-full overflow-visible">
          <polyline points={points} fill="none" className="stroke-emerald-800 dark:stroke-emerald-400" strokeWidth={1.25}
            strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Dots and labels sit outside the stretched SVG so they stay round and readable. */}
        <div className="relative -mt-10 h-10">
          {scores.map((score, index) => (
            <span key={index} className="absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-800 dark:bg-emerald-400"
              style={{ left: `${(x(index) / width) * 100}%`, top: `${(y(score) / height) * 100}%` }} />
          ))}
        </div>
        <div className="relative mt-1.5 h-3">
          {scores.map((_, index) => (
            <span key={index} className="absolute -translate-x-1/2 text-[8px] text-[#2f62c4]/70 tabular-nums dark:text-blue-400/80"
              style={{ left: `${(x(index) / width) * 100}%` }}>{index + 1}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
