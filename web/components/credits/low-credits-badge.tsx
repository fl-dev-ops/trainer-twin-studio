import { LOW_LEARNER_MINUTES } from "@/lib/minutes-config";

/** Flags a learner with fewer than LOW_LEARNER_MINUTES credits left (their calls will soon stop). */
export function LowCreditsBadge() {
  return (
    <span
      title={`Fewer than ${LOW_LEARNER_MINUTES} min of practice left`}
      className="shrink-0 rounded-full bg-caution-subtle px-2 py-0.5 text-overline font-medium text-caution"
    >
      Low
    </span>
  );
}
