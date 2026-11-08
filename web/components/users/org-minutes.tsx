"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

const LABEL: Record<string, string> = { topup: "Top-up", grant: "Given to", reclaim: "Taken back from" };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * The organization's practice minutes (lib/minutes.ts): what it can still give its learners, and its latest top-ups
 * and grants. TrainerTwin tops it up; learners get minutes from it when invited or assigned, or on their page.
 */
export function OrgMinutes() {
  const data = useQuery({ queryKey: ["minutes.org"], queryFn: () => api.minutes.org.query() });
  const m = data.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Practice minutes <span className="font-normal text-muted-foreground">· {m ? `${m.balanceMinutes.toLocaleString()} min left to give` : "…"}</span>
        </CardTitle>
        <CardDescription>
          {m
            ? `Each new learner gets ${m.defaultMinutes} min from this balance when invited or assigned; give more on their page (up to ${m.maxMinutes} min each). Contact TrainerTwin to top up.`
            : "Loading…"}
        </CardDescription>
      </CardHeader>
      {m?.history.length ? (
        <CardContent>
          <ul className="m-0 flex max-h-64 list-none flex-col divide-y overflow-y-auto rounded-lg border p-0 text-sm">
            {m.history.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{LABEL[row.type] ?? row.type}</span>
                  {row.type !== "topup" && row.note ? <span className="text-muted-foreground"> {row.note}</span> : null}
                  <span className="text-muted-foreground"> · {day(row.at)}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {row.type === "topup" || row.type === "reclaim" ? "+" : "−"}{Math.abs(row.minutes).toLocaleString()} min
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
