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

/** A claim older than this is a worker that died: another may take it over. */
const CLAIM_SECONDS = 2 * 60;

/**
 * Scores a call's calibration once (specs/practice.md rule 14), from the end workflow after the agent's final
 * transcript: claims it (so two workers never both call Jev), scores and saves it. Without questions for Jev the raw
 * counts are saved. Jev failing clears the claim and throws, for the workflow to retry. Already scored, claimed by
 * another worker, or no calibration: does nothing.
 */
export async function scoreCalibrationOnce(sessionId: string) {
  const claimedBefore = new Date(Date.now() - CLAIM_SECONDS * 1000);
  const { count } = await db.twinCalibration.updateMany({
    where: { sessionId, scoredAt: null, OR: [{ scoreClaimedAt: null }, { scoreClaimedAt: { lt: claimedBefore } }] },
    data: { scoreClaimedAt: new Date() },
  });
  if (!count) return null;
  const row = await db.twinCalibration.findUniqueOrThrow({
    where: { sessionId },
    select: {
      id: true,
      session: { select: { transcript: true, agent: { select: { name: true } } } },
      ratings: { select: { turnIndex: true, question: true, reply: true, rating: true } },
    },
  });
  const turns = attachRatings(transcriptTurns(row.session.transcript), row.ratings);
  const questions = scoreQuestions(turns);
  try {
    const score = Object.keys(questions).length ? scoreFrom(turns, await decide(stateFor(turns, row.session.agent.name), questions)) : rawScore(turns);
    await db.twinCalibration.update({ where: { id: row.id }, data: { turns: score.turns, offTurns: score.off, scoredAt: new Date() } });
    return score;
  } catch (error) {
    await db.twinCalibration.update({ where: { id: row.id }, data: { scoreClaimedAt: null } });
    throw error;
  }
}
