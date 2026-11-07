import type { ReactNode } from "react";
import { FeelsLikeMeIcon, FeelsOffIcon } from "@/components/calibration/call-icons";
import { MessageFileCard } from "@/components/copilot-composer";
import type { CalibrationTurn, Rating } from "@/components/calibration/mock";
import { Spinner } from "@/components/ui/spinner";
import { stripAttachments } from "@/lib/markers";
import { accuracyOf, type CalibrationScore } from "@/lib/twin/stats";
import { cn } from "@/lib/utils";

/** Shared prototype shadows. */
export const SOFT_SHADOW = "shadow-elevation-2";
/** The prototype's white pill button (Feels like me, Show more, secondary actions). */
export const PILL =
  "inline-flex h-8 items-center gap-2 rounded-full bg-card px-[18px] text-body-s font-semibold shadow-elevation-1 transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 outline-none dark:ring-1 dark:ring-border";

/** The twin's picture: its persona's photo, else the role-play card's light wash with an initial. */
export function TwinPortrait({ name, photoUrl = null, className }: { name: string; photoUrl?: string | null; className?: string }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- same-site avatar route (redirects to a presigned S3 URL)
    return <img src={photoUrl} alt="" aria-hidden className={cn("object-cover object-[center_20%]", className)} />;
  }
  return (
    <div
      aria-hidden
      className={cn(
        "grid place-items-center bg-art-pastel font-semibold text-night/80",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

/** Files the call attached, by upload id: their names and kinds for the file cards. */
export type AttachedFiles = ReadonlyMap<string, { name: string; mediaType: string | null }>;

/** Your line with the files it attached (its `[ATTACHED <id>]` markers) shown as file cards above the text. */
export function AttachedTurn({ text, files, className }: { text: string; files?: AttachedFiles; className?: string }) {
  const split = stripAttachments(text);
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {split.files.map((file) => {
          const known = files?.get(file.id);
          return (
            <MessageFileCard
              key={file.id}
              name={known?.name ?? file.name}
              mediaType={known?.mediaType ?? undefined}
              previewUrl={known?.mediaType?.startsWith("image/") ? `/api/uploads/${file.id}/view` : undefined}
            />
          );
        })}
      </div>
      {split.text.trim() ? <Bubble speaker="you" className={className}>{split.text}</Bubble> : null}
    </div>
  );
}

/** A transcript bubble: your lines outlined on the right, the twin's grey on the left. */
export function Bubble({ speaker, children, className }: { speaker: CalibrationTurn["speaker"]; children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "w-fit rounded-2xl text-sm leading-5 whitespace-pre-wrap",
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

/**
 * Turns / Feels off / Accuracy for a calibration: the trainer's real turns, the "Feels off" they meant (both counted by
 * Jev after the call), and the share of turns that felt like them. `score` null: still counting.
 */
export function CalibrationStats({ score }: { score: CalibrationScore | null }) {
  const accuracy = score ? accuracyOf(score) : null;
  const counting = <Spinner className="size-5 text-muted-foreground" />;
  const stats = [
    { label: "Turns", value: score ? score.turns : counting, note: score?.turns === 1 ? "turn" : "turns" },
    { label: "Feels off", value: score ? score.off : counting, note: score?.off === 1 ? "response" : "responses" },
    { label: "Accuracy", value: score ? (accuracy === null ? "—" : `${accuracy}%`) : counting, note: "Turns that felt like you" },
  ];
  return (
    <dl className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="flex flex-col gap-2 rounded-2xl border bg-card px-4 py-5 shadow-card"
        >
          <dt className="text-overline leading-3 font-medium tracking-overline text-muted-foreground uppercase">{stat.label}</dt>
          <dd className="flex flex-col gap-1">
            <span className="flex h-[34px] items-center text-2xl font-semibold tracking-title tabular-nums">{stat.value}</span>
            <span className="text-body-s leading-body-s text-muted-foreground">{stat.note}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
