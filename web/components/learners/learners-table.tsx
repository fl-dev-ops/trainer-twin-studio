import Link from "next/link";
import { UsersIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { SessionTime } from "@/components/sessions/session-time";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { LearnerRow } from "@/lib/learners";
import { cn } from "@/lib/utils";

const TINTS = [
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
];

function tintFor(key: string) {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

function formatPractice(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "< 1 min" : "—";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const COLUMNS = ["Learner", "Email", "Scenarios", "Sessions", "Practice time", "Last active"];

/** Users page body: every learner with their assignments and practice so far. */
export function LearnersTable({ learners }: { learners: LearnerRow[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <PageContainer className="flex flex-col gap-8">
        <PageHeader icon={UsersIcon} title="Users" />

        <section className="flex flex-col gap-3">
          <SectionHeader title="All learners" note="People practising your role plays and twin" />

          {learners.length === 0 ? (
            <Empty className="rounded-2xl border bg-card">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>No learners yet</EmptyTitle>
                <EmptyDescription>
                  Assign a <Link href="/agents" className="underline underline-offset-4">role play</Link> to invite learners.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-2xl border bg-card shadow-[0_1px_2px_rgba(30,28,25,0.04)]">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead className="bg-muted/40 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    {COLUMNS.map((label) => (
                      <th key={label} scope="col" className="px-5 py-3 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {learners.map((learner) => {
                    const href = learner.userId && learner.sessionCount > 0
                      ? `/sessions?learner=${encodeURIComponent(learner.userId)}&range=all`
                      : null;
                    return (
                      <tr
                        key={learner.email}
                        className={cn("relative", href && "transition-colors hover:bg-muted/40 focus-within:bg-muted/40")}
                      >
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-2.5">
                            <span
                              aria-hidden
                              className={cn(
                                "grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-medium",
                                tintFor(learner.email),
                              )}
                            >
                              {learner.name.charAt(0).toUpperCase()}
                            </span>
                            {href ? (
                              // Stretched link: the whole row opens this learner's sessions.
                              <Link href={href} className="truncate font-medium outline-none after:absolute after:inset-0">
                                {learner.name}
                              </Link>
                            ) : (
                              <span className="truncate font-medium">{learner.name}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-muted-foreground">{learner.email}</td>
                        <td className="px-5 py-3">{plural(learner.scenarioCount, "scenario")}</td>
                        <td className="px-5 py-3">{learner.sessionCount ? plural(learner.sessionCount, "session") : "—"}</td>
                        <td className="px-5 py-3">{formatPractice(learner.practiceSeconds)}</td>
                        <td className="px-5 py-3 text-muted-foreground">
                          {learner.lastActiveAt ? <SessionTime iso={learner.lastActiveAt} /> : "Not started"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </PageContainer>
    </div>
  );
}
