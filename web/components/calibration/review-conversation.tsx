"use client";

import { useState } from "react";
import type { CalibrationTurn } from "@/components/calibration/mock";
import { Bubble, RatingLabel } from "@/components/calibration/parts";
import { WhyButton, WhyPanel, useEvidenceTurns } from "@/components/calibration/why-panel";
import { lookupEvidence } from "@/lib/twin/evidence-match";
import type { TurnEvidence } from "@/lib/twin/evidence";

/** A finished calibration's conversation: each answer's rating, and "Why this answer" beside the replies that pulled evidence. */
export function ReviewConversation({ turns, sessionId }: { turns: CalibrationTurn[]; sessionId?: string }) {
  const evidenceTurns = useEvidenceTurns(sessionId);
  const [whyFor, setWhyFor] = useState<{ id: string; text: string; evidence: TurnEvidence } | null>(null);
  return (
    <>
      <ol className="mt-4 flex w-full flex-col gap-4">
        {turns.map((turn) => {
          // The icon shows only for replies the twin answered from a real lookup; a skill-only turn has none.
          const evidence = sessionId && turn.speaker === "twin" ? lookupEvidence(evidenceTurns ?? [], turn.text) : null;
          return (
            <li key={turn.id} className="flex flex-col gap-3">
              {turn.speaker === "twin" && evidence ? (
                <div className="flex max-w-[85%] items-start gap-2">
                  <Bubble speaker="twin">{turn.text}</Bubble>
                  <WhyButton open={whyFor?.id === turn.id} onClick={() => setWhyFor(whyFor?.id === turn.id ? null : { id: turn.id, text: turn.text, evidence })} />
                </div>
              ) : (
                <Bubble speaker={turn.speaker} className="max-w-[85%]">
                  {turn.text}
                </Bubble>
              )}
              {turn.rating ? <RatingLabel rating={turn.rating} /> : null}
            </li>
          );
        })}
      </ol>
      {whyFor ? <WhyPanel key={whyFor.id} turn={whyFor.evidence} onClose={() => setWhyFor(null)} /> : null}
    </>
  );
}
