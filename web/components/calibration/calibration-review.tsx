import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { CalibrationTurn } from "@/components/calibration/mock";
import { Bubble, CalibrationStats, RatingLabel, TwinPortrait } from "@/components/calibration/parts";
import { SessionTime } from "@/components/sessions/session-time";

/** A finished calibration (V2 prototype): the ratings up top, then the conversation with each answer's rating. */
export function CalibrationReview({
  backHref,
  twinName,
  startedAt,
  turns,
}: {
  backHref: string;
  twinName: string;
  startedAt: string;
  turns: CalibrationTurn[];
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <Link href={backHref} className="flex w-fit items-center gap-2 px-2 text-sm text-foreground/90 hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Calibrations
      </Link>

      <div className="mx-auto flex w-full max-w-[656px] flex-col items-center pt-8 pb-10">
        <TwinPortrait name={twinName} className="size-16 rounded-2xl text-2xl" />
        <h1 className="mt-3 text-lg font-semibold">{twinName}</h1>

        <div className="mt-6 w-full">
          <CalibrationStats turns={turns} />
        </div>

        <p className="mt-10 text-[13px] text-foreground/75">
          <SessionTime iso={startedAt} />
        </p>
        <ol className="mt-4 flex w-full flex-col gap-4">
          {turns.map((turn) => (
            <li key={turn.id} className="flex flex-col gap-3">
              <Bubble speaker={turn.speaker} className="max-w-[85%]">
                {turn.text}
              </Bubble>
              {turn.rating ? <RatingLabel rating={turn.rating} /> : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
