"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { DurationInput, parseMinutes } from "@/components/duration-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { MAX_LEARNER_MINUTES } from "@/lib/minutes-config";
import { useRefresh } from "@/lib/use-refresh";

export type BulkCreditsPerson = { email: string; name: string; givenMinutes: number };

/**
 * Adds the same credits to several learners at once, on top of what each has, from the org's balance. Shows before
 * saving who gets them, who is skipped (they'd pass MAX_LEARNER_MINUTES in total) and the org balance after; the add is
 * all or nothing when the balance is short.
 */
export function BulkAddCreditsDialog({ people, open, onOpenChange, onDone }: {
  people: BulkCreditsPerson[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const refresh = useRefresh();
  const org = useQuery({ queryKey: ["minutes.org"], queryFn: () => api.minutes.org.query(), enabled: open });
  const [value, setValue] = useState("30");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const minutes = parseMinutes(value);
  const getting = minutes === null ? [] : people.filter((person) => person.givenMinutes + minutes <= MAX_LEARNER_MINUTES);
  const skipped = minutes === null ? [] : people.filter((person) => person.givenMinutes + minutes > MAX_LEARNER_MINUTES);
  const total = minutes === null ? 0 : getting.length * minutes;
  const balance = org.data?.balanceMinutes ?? null;
  const blocked = minutes === null
    ? "Enter a whole number of minutes."
    : getting.length === 0
      ? `Nobody selected can get ${minutes} more min (${MAX_LEARNER_MINUTES} min each in total).`
      : balance !== null && total > balance
        ? `This needs ${total.toLocaleString()} min; your organization has ${balance.toLocaleString()} left. Contact TrainerTwin to top up.`
        : null;

  async function add() {
    if (blocked || minutes === null) return;
    setBusy(true);
    try {
      const result = await api.minutes.addMany.mutate({ emails: getting.map((person) => person.email), minutes, note: note.trim() || undefined });
      toast.success(`${minutes} min added for ${result.given.length} ${result.given.length === 1 ? "learner" : "learners"}`);
      if (result.skipped.length) toast.info(`Skipped: ${result.skipped.map((row) => `${row.email} ${row.reason}`).join("; ")}`);
      setNote("");
      refresh();
      onDone();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add credits");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add credits to {people.length} {people.length === 1 ? "learner" : "learners"}</DialogTitle>
          <DialogDescription>The same amount each, on top of what they have, from your organization&apos;s balance. 1 credit = 1 minute.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="bulk-credits-minutes" className="text-sm font-medium">Credits each</label>
            <DurationInput id="bulk-credits-minutes" value={value} onChange={setValue} />
          </div>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason (optional)" maxLength={200} aria-label="Reason" />
          <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Total</dt>
              <dd className="m-0 mt-0.5 font-semibold tabular-nums">{total.toLocaleString()} min · {getting.length} {getting.length === 1 ? "learner" : "learners"}</dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Org balance after</dt>
              <dd className="m-0 mt-0.5 font-semibold tabular-nums">{balance === null ? "…" : `${Math.max(0, balance - total).toLocaleString()} min`}</dd>
            </div>
          </dl>
          {skipped.length ? (
            <p className="m-0 text-xs text-caution">
              Skipped (would pass {MAX_LEARNER_MINUTES} min in total): {skipped.map((person) => `${person.name} (${MAX_LEARNER_MINUTES - person.givenMinutes} more possible)`).join(", ")}
            </p>
          ) : null}
          {blocked && minutes !== null ? <p role="alert" className="m-0 text-sm text-destructive">{blocked}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="brand" disabled={Boolean(blocked) || busy} onClick={() => void add()}>
            {busy ? "Adding…" : minutes ? `Add ${minutes} min each` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
