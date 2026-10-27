import { db } from "@/lib/db";
import { decide, topChoice, type JevQuestion } from "@/lib/jev";
import { attachRatings, isFeelsOffMessage, transcriptTurns, type CalibrationScore } from "@/lib/twin/stats";

type RatedTurn = ReturnType<typeof attachRatings>[number];
export type { CalibrationScore };

/** Without Jev: every trainer line except the "Feels off" button messages, and every "Feels off" rating. */
export function rawScore(turns: RatedTurn[]): CalibrationScore {
  return {
    turns: turns.filter((turn) => turn.who === "learner" && !isFeelsOffMessage(turn.text)).length,
    off: turns.filter((turn) => turn.rating === "off").length,
  };
}

const TURN: Record<string, string> = {
  conversation:
    "A real turn in the conversation with the twin: a question, an answer, a situation or a point the twin is meant to respond to (a greeting counts).",
  feedback:
    "Feedback on the twin's previous reply instead of conversation: saying it felt off, explaining what was wrong with it, or correcting how the twin said it.",
  noise: "Not a real turn: checking the audio or connection, filler, a cut-off fragment, or talking to someone else.",
};
const OFF: Record<string, string> = {
  meant: "Meant: the reply really doesn't sound like the trainer, and what the trainer says next explains or corrects it.",
  mistake: "A mis-click: the trainer says the reply was fine or that it was a mistake, or carries on with no complaint about it.",
};

/** The Jev questions for a calibration: one per trainer line, one per "Feels off" reply. */
export function scoreQuestions(turns: RatedTurn[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  turns.forEach((turn, i) => {
    if (turn.who === "learner" && !isFeelsOffMessage(turn.text)) {
      questions[`turn-${i}`] = { type: "choice", instructions: `Line [${i}], the trainer: "${turn.text}"`, criteria: TURN };
    }
    if (turn.who === "twin" && turn.rating === "off") {
      const next = turns.slice(i + 1, i + 4).map((t) => `${t.who === "twin" ? "Twin" : "Trainer"}: "${t.text}"`).join("\n");
      questions[`off-${i}`] = {
        type: "choice",
        instructions: `The trainer marked the twin's reply at line [${i}] as "Feels off":\n"${turn.text}"\nWhat came next:\n${next || "(nothing)"}`,
        criteria: OFF,
      };
    }
  });
  return questions;
}

/** Counts from Jev's answers: conversation turns, and "Feels off" that were meant (at most one per turn). */
export function scoreFrom(turns: RatedTurn[], answers: Record<string, { probabilities?: Record<string, number> }>): CalibrationScore {
  let count = 0;
  let off = 0;
  turns.forEach((turn, i) => {
    if (turn.who === "learner" && !isFeelsOffMessage(turn.text) && (topChoice(answers[`turn-${i}`]) ?? "conversation") === "conversation") count++;
    if (turn.who === "twin" && turn.rating === "off" && topChoice(answers[`off-${i}`]) !== "mistake") off++;
  });
  return { turns: count, off: Math.min(off, count) };
}

function stateFor(turns: RatedTurn[], twinName: string) {
  const lines = turns.map((turn, i) => `[${i}] ${turn.who === "twin" ? "Twin" : "Trainer"}${turn.rating === "off" ? " (marked Feels off)" : ""}: ${turn.text}`);
  // shortcut: the last ~24k characters of very long calls only; split into windows if calibrations get that long.
  let transcript = lines.join("\n");
  if (transcript.length > 24_000) transcript = transcript.slice(-24_000);
  return `A trainer is calibrating "${twinName}", an AI twin of themselves: they talk to it by voice and mark replies that don't
sound like them as "Feels off". Pressing "Feels off" makes the twin ask what felt off, and the trainer then explains.
Feels off can be pressed by mistake.

Transcript (line numbers in brackets):
${transcript}`;
}

/**
 * Scores a finished calibration with Jev and saves it: the trainer's real turns and the "Feels off" they meant.
 * Returns the raw counts (unsaved) when Jev can't be reached, so a later call can still score it.
 */
export async function scoreCalibration(orgId: string, calibrationId: string): Promise<CalibrationScore & { scored: boolean }> {
  const row = await db.twinCalibration.findFirst({
    where: { id: calibrationId, session: { orgId } },
    select: {
      session: { select: { transcript: true, agent: { select: { name: true } } } },
      ratings: { select: { turnIndex: true, question: true, reply: true, rating: true } },
    },
  });
  if (!row) throw new Error("Calibration not found");
  const turns = attachRatings(transcriptTurns(row.session.transcript), row.ratings);
  const questions = scoreQuestions(turns);
  if (!Object.keys(questions).length) return { ...rawScore(turns), scored: false };
  try {
    const score = scoreFrom(turns, await decide(stateFor(turns, row.session.agent.name), questions));
    await db.twinCalibration.update({ where: { id: calibrationId }, data: { turns: score.turns, offTurns: score.off, scoredAt: new Date() } });
    return { ...score, scored: true };
  } catch (error) {
    console.error("Calibration scoring failed:", error);
    return { ...rawScore(turns), scored: false };
  }
}
