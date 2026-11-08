"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { BulkAddCreditsDialog } from "@/components/credits/bulk-add-credits-dialog";
import { LowCreditsBadge } from "@/components/credits/low-credits-badge";
import { UsersIcon } from "@/components/icons";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { SessionTime } from "@/components/sessions/session-time";
import type { UsersRow } from "@/lib/learners";
import { LOW_LEARNER_MINUTES } from "@/lib/minutes-config";
import { cn } from "@/lib/utils";

function formatPractice(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "< 1 min" : "—";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Grid shared by the header row and the rows on the Users page. */
const USERS_GRID = "grid grid-cols-[28px_minmax(0,1.6fr)_120px_150px_130px_130px] gap-4";
const isLow = (user: UsersRow) => user.minutesLeft !== null && user.minutesLeft < LOW_LEARNER_MINUTES;

/**
 * Users page: every learner with their twin and role-play activity and credits left. Search, a "Low on credits"
 * filter, and selecting learners to add credits to all of them at once. Admin and team show "—" (no credits).
 */
export function UsersTable({ users }: { users: UsersRow[] }) {
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const q = query.trim().toLowerCase();
  const lowCount = users.filter(isLow).length;
  const filtered = users.filter((u) => (!lowOnly || isLow(u)) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
  // Only learners take credits: admin and team rows can't be selected.
  const selectable = filtered.filter((u) => u.minutesLeft !== null);
  const allShown = selectable.length > 0 && selectable.every((u) => selected.includes(u.email));
  const toggle = (email: string) => setSelected((prev) => (prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]));
  const toggleAll = () => setSelected((prev) => (allShown ? prev.filter((e) => !selectable.some((u) => u.email === e)) : [...new Set([...prev, ...selectable.map((u) => u.email)])]));
  const picked = users.filter((u) => selected.includes(u.email) && u.minutesGiven !== null);

  return (
    <PageContainer>
      <PageHeader icon={UsersIcon} title="Users" />

      <SectionHeader title="Users" note="Learners practising your twins and role plays" className="mt-10" />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="w-72 max-w-full">
          <SearchInput placeholder="Search users" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search users" />
        </div>
        <Button variant={lowOnly ? "secondary" : "outline"} size="sm" aria-pressed={lowOnly} onClick={() => setLowOnly((on) => !on)}>
          Low on credits <span className="tabular-nums text-muted-foreground">{lowCount}</span>
        </Button>
        {picked.length ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{picked.length} selected</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button>
            <Button variant="brand" size="sm" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" /> Add credits
            </Button>
          </div>
        ) : null}
      </div>

      <Card size="lg" className="mt-4 gap-0 py-0">
        <div className={cn(USERS_GRID, "items-center border-b px-5 py-2.5 text-body-s font-medium uppercase text-muted-foreground")}>
          <input
            type="checkbox"
            checked={allShown}
            disabled={!selectable.length}
            onChange={toggleAll}
            aria-label="Select all learners shown"
            className="size-4 accent-(--brand)"
          />
          <span>Learner</span>
          <span>Twin sessions</span>
          <span>Roleplay sessions</span>
          <span>Total duration</span>
          <span>Credits left</span>
        </div>
        {filtered.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            {users.length === 0 ? "No users yet." : lowOnly && !q ? "Nobody is low on credits." : "No users match this search."}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {filtered.map((user, idx) => (
              <li key={user.email} className={cn("relative", idx > 0 && "border-t border-border")}>
                {/* Stretched link: the whole row opens the user's page (their credits and twin sessions). */}
                {user.userId ? (
                  <Link
                    href={`/users/${user.userId}`}
                    aria-label={`Open ${user.name}`}
                    className="absolute inset-0 outline-none transition-colors hover:bg-(--sidebar) focus-visible:bg-(--sidebar)"
                  />
                ) : null}
                {/* Above the link for painting, but clicks pass through to it (except the checkbox). */}
                <div className={cn(USERS_GRID, "pointer-events-none relative items-center px-5 py-4")}>
                  {user.minutesLeft !== null ? (
                    <input
                      type="checkbox"
                      checked={selected.includes(user.email)}
                      onChange={() => toggle(user.email)}
                      aria-label={`Select ${user.name}`}
                      className="pointer-events-auto size-4 accent-(--brand)"
                    />
                  ) : (
                    <span />
                  )}
                  <span className="flex min-w-0 items-center gap-3">
                    <UserAvatar user={user} size="md" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-semibold leading-5">{user.name}</span>
                      <span className="text-body-s leading-body-s text-muted-foreground">
                        {user.lastActiveAt ? <SessionTime iso={user.lastActiveAt} /> : "Not started"}
                      </span>
                    </span>
                  </span>
                  <span className="tabular-nums">{user.twinSessions || "—"}</span>
                  <span className="tabular-nums">{user.roleplaySessions || "—"}</span>
                  <span className="tabular-nums">{formatPractice(user.practiceSeconds)}</span>
                  {user.minutesLeft === null ? (
                    <span className="text-muted-foreground" title="Admin and team practise without using credits">—</span>
                  ) : (
                    <span className="flex items-center gap-2 tabular-nums">
                      {user.minutesLeft} min
                      {isLow(user) ? <LowCreditsBadge /> : null}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <BulkAddCreditsDialog
        people={picked.map((u) => ({ email: u.email, name: u.name, givenMinutes: u.minutesGiven ?? 0 }))}
        open={adding}
        onOpenChange={setAdding}
        onDone={() => setSelected([])}
      />
    </PageContainer>
  );
}
