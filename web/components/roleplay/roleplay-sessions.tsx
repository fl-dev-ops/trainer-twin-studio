import Link from "next/link";
import { ArrowUpRight, History } from "lucide-react";
import { LearnerAvatar } from "@/components/roleplay/learner-avatar";
import { RoleplayPageHead } from "@/components/roleplay/page-head";
import { SessionWhen } from "@/components/roleplay/session-when";
import type { RoleplaySessionRow } from "@/lib/roleplay-sessions";

/** Role play sessions: every practice session learners took, newest first. */
export function RoleplaySessions({ rows }: { rows: RoleplaySessionRow[] }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[896px] px-4 pt-7 pb-12">
        <RoleplayPageHead icon={<History />} title="Role play sessions" section="Practice sessions" note="Sessions your learners took on your role plays" />
        {rows.length === 0 ? (
          <p className="rounded-2xl border px-6 py-12 text-center text-sm text-muted-foreground">
            No sessions yet. They appear here once learners practise on your role plays.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-card shadow-xs">
            {rows.map((row, index) => (
              <li key={row.id} className="border-b last:border-b-0">
                <Link href={`/sessions/${encodeURIComponent(row.id)}`}
                  className="flex items-center gap-3 px-5 py-4 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none">
                  <LearnerAvatar name={row.learner} index={index} className="size-10 text-base" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-semibold">{row.learner}</span>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {row.title} · <SessionWhen iso={row.at} />{row.minutes ? ` · ${row.minutes} min` : ""}
                    </span>
                    {row.score || row.line ? (
                      <span className="truncate text-[13px] text-muted-foreground">
                        {row.score ? `Score ${row.score}` : null}{row.score && row.line ? " · " : null}{row.line ? `“${row.line}”` : null}
                      </span>
                    ) : null}
                  </span>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
