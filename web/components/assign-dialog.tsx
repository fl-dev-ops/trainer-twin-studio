"use client";

import { useState } from "react";
import { Check, Search } from "lucide-react";
import { DurationInput, parseMinutes } from "@/components/duration-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

/** `pending`: invited, hasn't accepted yet (not a member of the org). */
export type AssignPerson = { email: string; name: string; image: string | null; pending?: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Assign a twin or a role play (reference assign dialog): the org's learners who are not assigned yet, searchable,
 * plus anyone invited by email; twins also set minutes per person. `onAssign` does the work and closes on success.
 */
export function AssignDialog({ variant, open, onOpenChange, title, assignedCount, people, defaultMinutes = 30, onAssign }: {
  variant: "twin" | "roleplay";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The twin's or role play's name. */
  title: string;
  assignedCount: number;
  /** Who can be picked: the org's learners minus the ones already assigned (the caller filters). */
  people: AssignPerson[];
  defaultMinutes?: number;
  onAssign: (emails: string[], minutes: number | null) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [invited, setInvited] = useState<string[]>([]);
  const [invite, setInvite] = useState("");
  const [minutes, setMinutes] = useState(String(defaultMinutes));
  const [busy, setBusy] = useState(false);

  const minutesValue = variant === "twin" ? parseMinutes(minutes) : null;
  const known = new Set(people.map((p) => p.email.toLowerCase()));
  const rows: AssignPerson[] = [...invited.map((email) => ({ email, name: email, image: null })), ...people];
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) : rows;
  const inviteEmails = invite.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const inviteValid = inviteEmails.length > 0 && inviteEmails.every((e) => EMAIL.test(e));
  const canAssign = picked.length > 0 && !busy && (variant === "roleplay" || minutesValue !== null);

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
    setMinutes(String(defaultMinutes));
  }

  async function assign() {
    if (!canAssign) return;
    setBusy(true);
    try {
      if (await onAssign(picked, minutesValue)) {
        reset();
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="flex max-h-[min(640px,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-lg">{variant === "twin" ? "Assign twin agent" : "Assign roleplay"}</DialogTitle>
          <DialogDescription>
            {title} · {assignedCount} assigned
            {picked.length ? <span className="text-(--brand)"> · {picked.length} selected</span> : null}
          </DialogDescription>
        </DialogHeader>

        {variant === "twin" ? (
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="assign-minutes" className="text-sm font-medium">Minutes per person</label>
            <DurationInput id="assign-minutes" value={minutes} onChange={setMinutes} />
          </div>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">Each person gets an email with their own link: one attempt, valid for 30 days.</p>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" aria-label="Search learners" />
        </div>

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
                  <UserAvatar user={person} className="size-8 text-xs" />
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
          <Button disabled={!canAssign} onClick={() => void assign()} className="bg-(--brand) text-white hover:bg-[#e04d00]">
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
    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
      Invite pending
    </span>
  );
}
