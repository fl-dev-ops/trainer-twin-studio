"use client";

import { useState } from "react";
import type { CalibrationTurn } from "@/components/calibration/mock";
import { Bubble, RatingLabel } from "@/components/calibration/parts";
import { WhyButton, WhyPanel } from "@/components/calibration/why-panel";

/** A finished calibration's conversation: each answer's rating, and "Why this answer" beside the twin's replies. */
export function ReviewConversation({ turns, sessionId }: { turns: CalibrationTurn[]; sessionId?: string }) {
  const [whyFor, setWhyFor] = useState<{ id: string; text: string } | null>(null);
  return (
    <>
      <ol className="mt-4 flex w-full flex-col gap-4">
        {turns.map((turn) => (
          <li key={turn.id} className="flex flex-col gap-3">
            {turn.speaker === "twin" && sessionId ? (
              <div className="flex max-w-[85%] items-start gap-2">
                <Bubble speaker="twin">{turn.text}</Bubble>
                <WhyButton open={whyFor?.id === turn.id} onClick={() => setWhyFor(whyFor?.id === turn.id ? null : { id: turn.id, text: turn.text })} />
              </div>
            ) : (
              <Bubble speaker={turn.speaker} className="max-w-[85%]">
                {turn.text}
              </Bubble>
            )}
            {turn.rating ? <RatingLabel rating={turn.rating} /> : null}
          </li>
        ))}
      </ol>
      {whyFor && sessionId ? <WhyPanel key={whyFor.id} sessionId={sessionId} reply={whyFor.text} onClose={() => setWhyFor(null)} /> : null}
    </>
  );
}
