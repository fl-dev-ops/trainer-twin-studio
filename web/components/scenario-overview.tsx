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
      <div className="grid gap-6 lg:grid-cols-2">
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
            <div className="w-fit rounded-xl bg-muted px-5 py-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Sessions</p>
              <p className="text-2xl font-semibold tabular-nums">{data.totalSessions}</p>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Sessions this week</p>
              <div className="flex h-24 items-end gap-2" role="img"
                aria-label={data.week.map((day) => `${day.label} ${day.count}`).join(", ")}>
                {data.week.map((day) => (
                  <div key={day.label} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] tabular-nums text-muted-foreground">{day.count || ""}</span>
                    <span
                      className="w-full rounded-sm bg-primary"
                      style={{ height: `${day.count ? Math.max(6, Math.round((day.count / weekMax) * 64)) : 2}px`, opacity: day.count ? 1 : 0.25 }}
                    />
                    <span className="text-[10px] text-muted-foreground">{day.label}</span>
                  </div>
                ))}
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
  const width = 300;
  const height = 64;
  const pad = 6;
  const step = (width - pad * 2) / (scores.length - 1);
  const y = (score: number) => pad + (1 - Math.max(0, Math.min(100, score)) / 100) * (height - pad * 2);
  const points = scores.map((score, index) => `${pad + index * step},${y(score)}`).join(" ");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Session scores <span className="font-normal text-muted-foreground">(last {scores.length})</span></p>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-full" role="img"
        aria-label={`Scores out of 100, oldest first: ${scores.join(", ")}`}>
        <line x1={pad} x2={width - pad} y1={y(50)} y2={y(50)} className="stroke-border" strokeDasharray="3 3" />
        <polyline points={points} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />
        {scores.map((score, index) => (
          <circle key={index} cx={pad + index * step} cy={y(score)} r={3} className="fill-primary" />
        ))}
      </svg>
    </div>
  );
}
