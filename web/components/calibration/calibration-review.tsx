import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { CalibrationTurn } from "@/components/calibration/mock";
import { CalibrationStats, TwinPortrait } from "@/components/calibration/parts";
import { ReviewConversation } from "@/components/calibration/review-conversation";
import { SessionTime } from "@/components/sessions/session-time";
import type { CalibrationScore } from "@/lib/twin/stats";

/** A finished calibration (V2 prototype): the ratings up top, then the conversation with each answer's rating. */
export function CalibrationReview({
  backHref,
  twinName,
  photoUrl = null,
  startedAt,
  turns,
  score,
  sessionId,
}: {
  backHref: string;
  twinName: string;
  /** The twin's persona photo; without it, the initial on a wash. */
  photoUrl?: string | null;
  startedAt: string;
  turns: CalibrationTurn[];
  /** Jev's turns / meant Feels off (raw counts until scored). */
  score: CalibrationScore;
  /** The call's session, for each reply's "Why this answer" (none on the demo calibration). */
  sessionId?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <Link href={backHref} className="flex w-fit items-center gap-2 px-2 text-sm text-foreground/90 hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Calibrations
      </Link>

      <div className="mx-auto flex w-full max-w-[656px] flex-col items-center pt-8 pb-10">
        <TwinPortrait name={twinName} photoUrl={photoUrl} className="size-16 rounded-2xl text-2xl" />
        <h1 className="mt-3 text-lg font-semibold">{twinName}</h1>

        <div className="mt-6 w-full">
          <CalibrationStats score={score} />
        </div>

        <p className="mt-10 text-[13px] text-foreground/75">
          <SessionTime iso={startedAt} />
        </p>
        <ReviewConversation turns={turns} sessionId={sessionId} />
      </div>
    </div>
  );
}
