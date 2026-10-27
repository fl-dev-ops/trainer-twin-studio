import type { ReactNode } from "react";
import { FeelsLikeMeIcon, FeelsOffIcon } from "@/components/calibration/call-icons";
import type { CalibrationTurn, Rating } from "@/components/calibration/mock";
import { cn } from "@/lib/utils";

/** Shared prototype shadows. */
export const SOFT_SHADOW = "shadow-[0_2px_4px_rgba(30,28,25,0.07),0_8px_20px_rgba(30,28,25,0.11)]";
/** The prototype's white pill button (Feels like me, Show more, secondary actions). */
export const PILL =
  "inline-flex h-8 items-center gap-2 rounded-full bg-card px-[18px] text-[13px] font-semibold shadow-[0_0_1px_rgba(0,0,0,0.4),0_1px_1px_rgba(0,0,0,0.04),0_2px_4px_rgba(0,0,0,0.04)] transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 outline-none dark:shadow-[0_0_0_1px_var(--border)]";

/**
 * The twin's picture. Personas have no photo yet, so it's the role-play card's light wash with an initial.
 * shortcut: initial only, swap in the persona photo/video once personas have one.
 */
export function TwinPortrait({ name, className }: { name: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "grid place-items-center bg-[linear-gradient(135deg,#a8c6ec_0%,#d2c3e8_50%,#f1c6d7_100%)] font-semibold text-neutral-800/80",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

/** A transcript bubble: your lines outlined on the right, the twin's grey on the left. */
export function Bubble({ speaker, children, className }: { speaker: CalibrationTurn["speaker"]; children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "w-fit rounded-[20px] text-sm leading-5 whitespace-pre-wrap",
        speaker === "you" ? "self-end bg-card px-5 py-2.5 ring-1 ring-border ring-inset" : "bg-muted px-4 py-2.5",
        className,
      )}
    >
      {children}
    </p>
  );
}

export const RATING_LABEL: Record<Rating, string> = { like: "Feels like me", off: "Feels off" };

/** The small "Feels like me / Feels off" note left under a rated answer. */
export function RatingLabel({ rating, className }: { rating: Rating; className?: string }) {
  const Icon = rating === "like" ? FeelsLikeMeIcon : FeelsOffIcon;
  return (
    <p className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <Icon className="size-4" />
      {RATING_LABEL[rating]}
    </p>
  );
}

const plural = (n: number) => (n === 1 ? "response" : "responses");

/** Feels like me / Feels off / Response accuracy, as on the prototype's call summary. */
export function CalibrationStats({ turns }: { turns: Pick<CalibrationTurn, "rating">[] }) {
  const like = turns.filter((t) => t.rating === "like").length;
  const off = turns.filter((t) => t.rating === "off").length;
  const accuracy = like + off ? Math.round((like / (like + off)) * 100) : null;
  const stats = [
    { label: "Feels like me", value: like, note: plural(like) },
    { label: "Feels off", value: off, note: plural(off) },
    { label: "Response accuracy", value: accuracy === null ? "—" : `${accuracy}%`, note: "Rated “Feels like me”" },
  ];
  return (
    <dl className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="flex flex-col gap-2 rounded-2xl border bg-card px-4 py-5 shadow-[0_2px_4px_rgba(30,28,25,0.035),0_8px_20px_rgba(30,28,25,0.055)]"
        >
          <dt className="text-[11px] leading-3 font-medium tracking-[0.06em] text-muted-foreground uppercase">{stat.label}</dt>
          <dd className="flex flex-col gap-1">
            <span className="text-[28px] leading-[34px] font-semibold tracking-[-0.015em]">{stat.value}</span>
            <span className="text-[13px] leading-[18px] text-muted-foreground">{stat.note}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
