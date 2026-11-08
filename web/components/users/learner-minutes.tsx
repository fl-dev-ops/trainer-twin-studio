"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DurationInput, parseMinutes } from "@/components/duration-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const LABEL: Record<string, string> = { grant: "Given", reclaim: "Taken back", usage: "Practice call", topup: "Top-up" };
const day = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
/** Signed minutes with one decimal for calls ("−4.5 min"), whole for grants. */
const amount = (minutes: number) => `${minutes > 0 ? "+" : minutes < 0 ? "−" : ""}${Math.abs(minutes).toLocaleString()} min`;

/**
 * One learner's practice minutes (lib/minutes.ts): what's left, given and used across every twin and role play; give
 * more from the org's balance or take unused minutes back; every movement, newest first.
 */
export function LearnerMinutes({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const key = ["minutes.learner", email];
  const data = useQuery({ queryKey: key, queryFn: () => api.minutes.learner.query({ email }) });
  const [value, setValue] = useState("30");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"add" | "takeBack" | null>(null);
  const minutes = parseMinutes(value);

  async function change(kind: "add" | "takeBack") {
    if (minutes === null) return;
    setBusy(kind);
    try {
      const input = { email, minutes, note: note.trim() || undefined };
      if (kind === "add") await api.minutes.add.mutate(input);
      else await api.minutes.takeBack.mutate(input);
      toast.success(kind === "add" ? `${minutes} min given` : `${minutes} min taken back`);
      setNote("");
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ["minutes.org"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the minutes");
    } finally {
      setBusy(null);
    }
  }

  const m = data.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Practice minutes</CardTitle>
        <CardDescription>
          Shared across every twin and role play. Calls stop when they run out.
          {m ? ` Your organization has ${m.orgBalanceMinutes.toLocaleString()} min left to give.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="m-0 grid grid-cols-3 gap-3">
          {[
            ["Left", m ? `${m.balanceMinutes} min` : "…"],
            ["Given", m ? `${m.givenMinutes} of ${m.maxMinutes} min` : "…"],
            ["Used", m ? `${m.usedMinutes} min` : "…"],
          ].map(([label, text]) => (
            <div key={label} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="m-0 mt-1 text-lg font-semibold tabular-nums">{text}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <DurationInput value={value} onChange={setValue} aria-label="Minutes to give or take back" />
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason (optional)" maxLength={200} className="min-w-40 flex-1" aria-label="Reason" />
          <Button variant="brand" disabled={minutes === null || busy !== null} onClick={() => void change("add")}>
            {busy === "add" ? "Giving…" : "Give minutes"}
          </Button>
          <Button variant="outline" disabled={minutes === null || busy !== null || !m?.balanceMinutes} onClick={() => void change("takeBack")}>
            {busy === "takeBack" ? "Taking back…" : "Take back"}
          </Button>
        </div>

        {m?.history.length ? (
          <ul className="m-0 flex list-none flex-col divide-y rounded-lg border p-0 text-sm">
            {m.history.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{LABEL[row.type] ?? row.type}</span>
                  <span className="truncate text-xs text-muted-foreground">{row.note ? `${row.note} · ` : ""}{day(row.at)}</span>
                </span>
                <span className="shrink-0 tabular-nums">{amount(row.minutes)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
