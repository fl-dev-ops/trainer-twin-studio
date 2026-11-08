"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { DurationInput, parseMinutes } from "@/components/duration-input";
import { api } from "@/lib/api";
import { DEFAULT_LEARNER_MINUTES, MAX_LEARNER_MINUTES } from "@/lib/minutes-config";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import { SearchInput } from "@/components/search-input";

/** `pending`: invited, hasn't accepted yet (not a member of the org). */
export type AssignPerson = { email: string; name: string; image: string | null; pending?: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Assign a twin or a role play (reference assign dialog): the org's learners who are not assigned yet, searchable,
 * plus anyone invited by email; twins also take an optional end date. Minutes are the learner's own: someone new gets
 * the starting minutes from the org's balance (shown here). `onAssign` does the work and closes on success.
 */
/** Today as "YYYY-MM-DD" in this browser's time zone (the date input's earliest day). */
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

export function AssignDialog({ variant, open, onOpenChange, title, assignedCount, people, onAssign }: {
  variant: "twin" | "roleplay";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The twin's or role play's name. */
  title: string;
  assignedCount: number;
  /** Who can be picked: the org's learners minus the ones already assigned (the caller filters). */
  people: AssignPerson[];
  /**
   * accessUntil: the end of the chosen day in this browser's time zone (ISO), or null for no end date.
   * startingMinutes: the credits each new person starts with (people who already have credits keep theirs).
   */
  onAssign: (emails: string[], accessUntil: string | null, startingMinutes: number) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [invited, setInvited] = useState<string[]>([]);
  const [invite, setInvite] = useState("");
  const orgMinutes = useQuery({ queryKey: ["minutes.org"], queryFn: () => api.minutes.org.query(), enabled: open });
  const [starting, setStarting] = useState(String(DEFAULT_LEARNER_MINUTES));
  const startingParsed = parseMinutes(starting);
  const startingMinutes = startingParsed !== null && startingParsed <= MAX_LEARNER_MINUTES ? startingParsed : null;
  // The most the picked people could take from the balance (people who already have credits take nothing).
  const mostNeeded = startingMinutes !== null ? startingMinutes * picked.length : 0;
  const balance = orgMinutes.data?.balanceMinutes ?? null;
  /** "YYYY-MM-DD" from the date input; empty = no end date. */
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);

  const known = new Set(people.map((p) => p.email.toLowerCase()));
  const rows: AssignPerson[] = [...invited.map((email) => ({ email, name: email, image: null })), ...people];
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) : rows;
  const inviteEmails = invite.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const inviteValid = inviteEmails.length > 0 && inviteEmails.every((e) => EMAIL.test(e));
  const canAssign = picked.length > 0 && !busy && startingMinutes !== null;

  const toggle = (email: string) => setPicked((prev) => (prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]));
  function addInvites() {
    if (!inviteValid) return;
    setInvited((prev) => [...prev, ...inviteEmails.filter((e) => !known.has(e) && !prev.includes(e))]);
    setPicked((prev) => [...new Set([...prev, ...inviteEmails])]);
    setInvite("");
  }
  function reset() {
    setQuery("");
    setPicked([]);
    setInvited([]);
    setInvite("");
    setUntil("");
    setStarting(String(DEFAULT_LEARNER_MINUTES));
  }

  async function assign() {
    if (!canAssign) return;
    setBusy(true);
    try {
      // The whole chosen day counts: access ends at its last moment, in the assigner's time zone.
      const accessUntil = variant === "twin" && until ? new Date(`${until}T23:59:59.999`).toISOString() : null;
      if (startingMinutes === null) return;
      if (await onAssign(picked, accessUntil, startingMinutes)) {
        reset();
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="flex max-h-[min(640px,calc(100dvh-2.2rem))] flex-col gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-lg">{variant === "twin" ? "Assign twin agent" : "Assign roleplay"}</DialogTitle>
          <DialogDescription>
            {title} · {assignedCount} assigned
            {picked.length ? <span className="text-(--brand)"> · {picked.length} selected</span> : null}
          </DialogDescription>
        </DialogHeader>

        {variant === "twin" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="assign-until" className="flex flex-col text-sm font-medium">
                Access until
                <span className="text-xs font-normal text-muted-foreground">Optional. No calls can start after this day.</span>
              </label>
              <Input id="assign-until" type="date" min={today()} value={until} onChange={(event) => setUntil(event.target.value)} className="w-40" />
            </div>
          </div>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">Each person gets an email with their own link: one attempt, valid for 30 days.</p>
        )}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="assign-credits" className="flex flex-col text-sm font-medium">
              Starting credits
              <span className="text-xs font-normal text-muted-foreground">For people new to credits. Others keep what they have.</span>
            </label>
            <DurationInput id="assign-credits" value={starting} onChange={setStarting} />
          </div>
          {startingParsed !== null && startingParsed > MAX_LEARNER_MINUTES ? (
            <p role="alert" className="m-0 text-xs text-destructive">At most {MAX_LEARNER_MINUTES} min per learner.</p>
          ) : balance !== null ? (
            <p className={cn("m-0 text-xs", picked.length && mostNeeded > balance ? "text-caution" : "text-muted-foreground")}>
              Your organization has {balance.toLocaleString()} credits left
              {picked.length && startingMinutes !== null ? `; this takes up to ${mostNeeded.toLocaleString()}` : ""}.
              {picked.length && mostNeeded > balance ? " If everyone picked is new, it won't fit." : " 1 credit = 1 min, shared across twins and role plays."}
            </p>
          ) : null}
        </div>

        <SearchInput placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search learners" />

        <ul className="m-0 min-h-24 flex-1 list-none overflow-y-auto rounded-lg border border-input p-0">
          {shown.length === 0 ? (
            <li className="p-6 text-center text-sm text-muted-foreground">
              {q ? "No one matches that search." : "Everyone in your organization is assigned. Invite someone by email below."}
            </li>
          ) : null}
          {shown.map((person, i) => {
            const on = picked.includes(person.email);
            return (
              <li key={person.email} className={cn(i > 0 && "border-t border-input")}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60">
                  <input type="checkbox" checked={on} onChange={() => toggle(person.email)} className="size-4 accent-(--brand)" aria-label={`Assign ${person.name}`} />
                  <UserAvatar user={person} size="md" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{person.name}</span>
                    {person.pending ? (
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {person.name !== person.email ? <span className="truncate">{person.email}</span> : null}
                        <PendingBadge />
                      </span>
                    ) : person.name !== person.email ? (
                      <span className="truncate text-xs text-muted-foreground">{person.email}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">New · gets an invite</span>
                    )}
                  </span>
                  {on ? <Check className="size-4 shrink-0 text-(--brand)" aria-hidden /> : null}
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex gap-2">
          <Input
            type="text"
            inputMode="email"
            autoComplete="off"
            placeholder="Invite by email"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addInvites();
              }
            }}
            aria-label="Invite by email"
            aria-invalid={invite.trim() !== "" && !inviteValid}
          />
          <Button variant="outline" disabled={!inviteValid} onClick={addInvites}>Add</Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="brand" disabled={!canAssign} onClick={() => void assign()} >
            {busy ? "Assigning…" : picked.length > 1 ? `Assign ${picked.length}` : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Invited but not joined yet (hasn't accepted the invite / opened their link). */
export function PendingBadge() {
  return (
    <span className="shrink-0 rounded-full bg-caution-subtle px-2 py-0.5 text-overline font-medium text-caution">
      Invite pending
    </span>
  );
}
