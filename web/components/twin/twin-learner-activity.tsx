import { PendingBadge } from "@/components/assign-dialog";
import { SessionTime } from "@/components/sessions/session-time";
import { helpfulTone } from "@/components/twin/twin-session-item";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { UserAvatar } from "@/components/user-avatar";
import type { TwinOutputs } from "@/lib/twin/trpc";
import { cn } from "@/lib/utils";

export type TwinLearner = TwinOutputs["agents"]["get"]["learners"][number];

/** Who uses one twin and how much (twin detail, Learners tab). A row with sessions opens them in the Sessions tab. */
export function TwinLearnerActivity({ learners, onSelect }: { learners: TwinLearner[]; onSelect: (learner: TwinLearner) => void }) {
  if (!learners.length) return <p className="py-3.5 text-sm text-muted-foreground">Nobody is assigned to this twin yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {learners.map((learner, i) => {
        const pct = learner.minutes ? Math.min(100, Math.round((learner.used / learner.minutes) * 100)) : 0;
        return (
          <li key={learner.email} className={cn(i > 0 && "border-t border-border")}>
            <button
              type="button"
              disabled={!learner.sessions}
              onClick={() => onSelect(learner)}
              className="grid w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3.5 p-4 px-5 text-left transition-colors outline-none enabled:hover:bg-(--sidebar) focus-visible:bg-(--sidebar)"
            >
              <UserAvatar user={{ name: learner.name, email: learner.email, image: learner.image }} size="xl" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold">{learner.name}</span>
                  {learner.pending ? <PendingBadge /> : null}
                </span>
                <span className="text-body-s leading-body-s text-muted-foreground">
                  {learner.sessions && learner.lastAt ? (
                    <>
                      {learner.sessions} {learner.sessions === 1 ? "session" : "sessions"} · last active <SessionTime iso={learner.lastAt} />
                    </>
                  ) : (
                    "Not started yet"
                  )}
                </span>
              </span>
              <span className="flex items-center gap-4">
                {learner.helpScore !== null ? <Badge variant={helpfulTone(learner.helpScore)}>Helpful {learner.helpScore}/5</Badge> : null}
                {pct >= 90 ? <Badge variant="warning">Low minutes</Badge> : null}
                <span className="flex w-28 flex-col gap-1.5">
                  <span className="text-right text-body-s text-muted-foreground tabular-nums">
                    {learner.used} of {learner.minutes} min
                  </span>
                  <Progress value={pct} aria-label={`${learner.used} of ${learner.minutes} minutes used`} />
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
