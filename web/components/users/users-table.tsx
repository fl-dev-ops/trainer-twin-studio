"use client";

import Link from "next/link";
import { useState } from "react";
import { UsersIcon } from "@/components/icons";
import { SearchInput } from "@/components/search-input";
import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { SessionTime } from "@/components/sessions/session-time";
import type { UsersRow } from "@/lib/learners";
import { cn } from "@/lib/utils";

function formatPractice(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "< 1 min" : "—";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Grid shared by the header row and the rows on the Users page. */
const USERS_GRID = "grid grid-cols-[minmax(0,1.6fr)_120px_150px_130px_110px] gap-4";

/** Users page: every learner with their twin and role-play activity. Search in the header, no filters. */
export function UsersTable({ users }: { users: UsersRow[] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) : users;

  return (
    <PageContainer>
      <PageHeader icon={UsersIcon} title="Users" />

      <SectionHeader title="Users" note="Learners practising your twins and role plays" className="mt-10" />

      <div className="mt-4 w-72 max-w-full">
        <SearchInput
          placeholder="Search users"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search users"
        />
      </div>

      <Card size="lg" className="mt-4 gap-0 py-0">
        <div className={cn(USERS_GRID, "border-b px-5 py-2.5 text-body-s font-medium uppercase text-muted-foreground")}>
          <span>Learner</span>
          <span>Twin sessions</span>
          <span>Roleplay sessions</span>
          <span>Total duration</span>
          <span>Credits left</span>
        </div>
        {filtered.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            {users.length === 0 ? "No users yet." : "No users match this search."}
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
                {/* Above the link for painting, but clicks pass through to it. */}
                <div className={cn(USERS_GRID, "pointer-events-none relative items-center px-5 py-4")}>
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
                    <span className={cn("tabular-nums", user.minutesLeft < 5 && "text-(--color-danger)")}>{user.minutesLeft} min</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
