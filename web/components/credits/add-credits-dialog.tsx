"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DurationInput, parseMinutes } from "@/components/duration-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

/**
 * Adds credits to a learner, on top of what they have, from the org's balance. The limits are shown before saving:
 * the org's balance after, and how many more this learner can get (at most `maxMinutes` given in total).
 */
export function AddCreditsDialog({ email, name, open, onOpenChange, givenMinutes, maxMinutes, orgBalanceMinutes }: {
  email: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  givenMinutes: number;
  maxMinutes: number;
  orgBalanceMinutes: number;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("30");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const minutes = parseMinutes(value);
  const room = Math.max(0, maxMinutes - givenMinutes);
  // Why the amount can't be added, said before saving (null: it can).
  const blocked = minutes === null
    ? "Enter a whole number of minutes."
    : room === 0
      ? `${name} already has the most credits one learner can be given (${maxMinutes} min).`
      : minutes > room
        ? `${name} can get at most ${room} more min (${maxMinutes} min in total).`
        : minutes > orgBalanceMinutes
          ? `Your organization has ${orgBalanceMinutes} min left to give. Contact TrainerTwin to top up.`
          : null;

  async function add() {
    if (blocked || minutes === null) return;
    setBusy(true);
    try {
      await api.minutes.add.mutate({ email, minutes, note: note.trim() || undefined });
      toast.success(`${minutes} min added for ${name}`);
      await Promise.all(["minutes.learner", "minutes.org", "page.credits", "page.users"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      setNote("");
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
          <DialogTitle>Add credits</DialogTitle>
          <DialogDescription>Added on top of what {name} has, from your organization&apos;s balance. 1 credit = 1 minute.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="add-credits-minutes" className="text-sm font-medium">Credits to add</label>
            <DurationInput id="add-credits-minutes" value={value} onChange={setValue} />
          </div>
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason (optional)" maxLength={200} aria-label="Reason" />
          <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Org balance after</dt>
              <dd className="m-0 mt-0.5 font-semibold tabular-nums">{Math.max(0, orgBalanceMinutes - (minutes ?? 0)).toLocaleString()} min</dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">Can still get</dt>
              <dd className="m-0 mt-0.5 font-semibold tabular-nums">{room} of {maxMinutes} min</dd>
            </div>
          </dl>
          {blocked && minutes !== null ? <p role="alert" className="m-0 text-sm text-destructive">{blocked}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="brand" disabled={Boolean(blocked) || busy} onClick={() => void add()}>
            {busy ? "Adding…" : minutes ? `Add ${minutes} min` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
