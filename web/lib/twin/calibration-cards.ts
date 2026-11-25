/**
 * Card calibrations (calibration v2): the coach asks the twin in text, one card at a time. Each card is its own
 * conversation in the chat service (x-trainertwin-conversation-id), so the twin starts fresh on every card while its
 * context (persona, skills, knowledge) still comes from the calibration's session. No greeting: nothing sends
 * "session-start", so the twin's first words answer the card's question.
 */

import { db } from "@/lib/db";
import { orgPeople } from "@/lib/org-people";
import { AppError, refusals } from "@/lib/errors";
import { agentVoiceId, startSessionNow } from "@/lib/session-activation";
import type { Prisma } from "@/lib/generated/prisma/client";
import { CARDS_PER_ROUND, nextCalibrationQuestions } from "@/lib/twin/calibration-questions";
import { OFF_REASONS, isOffReason, type OffReason } from "@/lib/twin/calibration-reasons";
import { RELIABLE_PACKS, wilson } from "@/lib/twin/reliable-score";

/** The reply text from the chat service's OpenAI-style stream: the content deltas, joined. */
export function replyFromStream(body: string): string {
  let reply = "";
  for (const line of body.split("\n")) {
    const data = line.startsWith("data: ") ? line.slice(6).trim() : null;
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === "string") reply += content;
    } catch {
      // Not JSON (a comment or keep-alive): skip it.
    }
  }
  return reply.trim();
}

/** Ask the twin one learner line on one card; resolves to its reply. Throws when the chat service fails. */
export async function askTwinOnCard(input: {
  orgId: string;
  sessionId: string;
  agentSlug: string;
  cardId: string;
  text: string;
}): Promise<string> {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  const response = await fetch(new URL("/v1/chat/completions", process.env.CHAT_URL ?? "http://localhost:2000"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${input.orgId}:${secret}`).toString("base64")}`,
      "x-trainertwin-session-id": input.sessionId,
      "x-trainertwin-conversation-id": input.cardId,
      "x-trainertwin-agent-slug": input.agentSlug,
      "x-trainertwin-mode": "chat",
    },
    body: JSON.stringify({ model: "trainertwin-brain", stream: true, messages: [{ role: "user", content: input.text }] }),
  });
  if (!response.ok) throw new Error(`Twin reply failed (${response.status})`);
  const reply = replyFromStream(await response.text());
  if (!reply) throw new Error("The twin sent an empty reply");
  return reply;
}

/**
 * Learner lines per card: its question only (one answer per card).
 */
export const MAX_TURNS_PER_CARD = 1;
/** Ratings of one card use turnIndex position * TURN_STRIDE + n, unique within the calibration. */
const TURN_STRIDE = 10;

/** The coach's own live card calibration (specs/practice.md rule 13: only its creator rates, while it is live). */
export async function liveCardCalibration(orgId: string, userId: string, calibrationId: string) {
  const row = await db.twinCalibration.findFirst({
    where: { id: calibrationId, createdByUserId: userId, session: { orgId, deletedAt: null, mode: "chat", agent: { archivedAt: null } } },
    select: { id: true, sessionId: true, session: { select: { status: true, agentId: true, agentSlug: true } } },
  });
  if (!row) throw refusals.notFound();
  if (!["activating", "active"].includes(row.session.status)) throw new AppError("calibration_ended", "This calibration has ended.", 409);
  return row;
}

/** A pack and its cards, each with its question and its marked answers (whichever visit gave them). */
const packSelect = {
  id: true,
  status: true,
  createdAt: true,
  cards: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      topic: true,
      question: { select: { text: true, source: true } },
      ratings: { orderBy: { turnIndex: "asc" }, select: { turnIndex: true, question: true, reply: true, rating: true, reasons: true, correction: true, learnerSource: true } },
    },
  },
} as const satisfies Prisma.TwinCalibrationPackSelect;

/**
 * The coach's open pack for a twin, or a new one: its 10 questions (balanced across the twin's skills) become its 10
 * cards up front. One open pack per coach per twin (a partial unique index): a second tab finds the first's.
 */
export async function openPack(input: { orgId: string; userId: string; agentId: string }) {
  const open = { agentId: input.agentId, createdByUserId: input.userId, status: "open" };
  const existing = await db.twinCalibrationPack.findFirst({ where: open, select: packSelect });
  if (existing) return existing;
  const questions = await nextCalibrationQuestions({ orgId: input.orgId, agentId: input.agentId, count: CARDS_PER_ROUND });
  if (!questions.length) throw new AppError("no_questions", "This twin's skills list no situations to ask about yet.", 409);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: input.agentId }, select: { version: true } });
  try {
    return await db.$transaction(async (tx) => {
      const pack = await tx.twinCalibrationPack.create({ data: { orgId: input.orgId, agentId: input.agentId, createdByUserId: input.userId }, select: { id: true } });
      await tx.twinCalibrationCard.createMany({
        data: questions.map((question, position) => ({ packId: pack.id, questionId: question.id, position, topic: question.topic, agentVersion: agent.version })),
      });
      await tx.twinCalibrationQuestion.updateMany({ where: { id: { in: questions.map((question) => question.id) } }, data: { status: "asked", askedAt: new Date() } });
      return tx.twinCalibrationPack.findUniqueOrThrow({ where: { id: pack.id }, select: packSelect });
    });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "P2002") throw error;
    return db.twinCalibrationPack.findFirstOrThrow({ where: open, select: packSelect });
  }
}

/**
 * The coach whose twin it is: the org admin (a twin is the admin's own persona). Only her calibrations count toward
 * the twin's numbers; a team member's are tests, saved and reviewable but not counted.
 */
export async function calibrationCoach(orgId: string) {
  const [admin] = await orgPeople(orgId, { roles: ["admin"], includeDisabled: true });
  return admin ? { userId: admin.userId, name: admin.name } : null;
}

/**
 * Starts a visit to Calibrate: a text calibration session (the twin's context for this visit; no greeting, nothing is
 * said until a card asks), the coach's open pack to carry on with, and the twin's voice for reading answers aloud.
 */
export async function startCardCalibration(input: { orgId: string; user: { id: string; name: string; email: string }; slug: string }) {
  const started = await startSessionNow({
    orgId: input.orgId, userId: input.user.id, userName: input.user.name, userEmail: input.user.email,
    agentSlug: input.slug, mode: "chat", calibrate: true,
  });
  if (!started.ok) throw new AppError(started.code ?? "start_failed", started.error, started.status);
  if (!started.session.calibrationId) throw new Error("The calibration was not created");
  const agent = await db.agent.findUniqueOrThrow({ where: { slug: input.slug }, select: { id: true, data: true, persona: { select: { voiceId: true } } } });
  const [pack, coach] = await Promise.all([openPack({ orgId: input.orgId, userId: input.user.id, agentId: agent.id }), calibrationCoach(input.orgId)]);
  const teamTest = coach && coach.userId !== input.user.id ? { coachName: coach.name } : null;
  return {
    // A team member's pack is a test: saved, not counted toward the coach's accuracy.
    teamTest,
    // The coach's packs toward a reliable score (none for a team member: her packs don't count).
    score: teamTest ? null : await twinScore(input.orgId, agent.id),
    calibrationId: started.session.calibrationId,
    sessionId: started.session.id,
    // Answers are read aloud in the twin's own voice (the page asks /api/tts/speech), as on a call.
    voice: (await agentVoiceId(input.orgId, agent)) ?? null,
    pack: {
      id: pack.id,
      cards: pack.cards.map((card) => ({
        id: card.id,
        question: card.question?.text ?? card.ratings[0]?.question ?? "",
        skill: card.question?.source ?? "Your own question",
        topic: card.topic,
        turns: card.ratings.map((rating) => ({
          learner: rating.question ?? "", reply: rating.reply, turnIndex: rating.turnIndex,
          rating: rating.rating as "like" | "off", reasons: rating.reasons, correction: rating.correction,
          source: (rating.learnerSource ?? "suggested") as "suggested" | "edited" | "own",
        })),
      })),
    },
  };
}

/**
 * One of the coach's cards this visit can ask on: a card of her open pack for this twin, or one asked within this
 * visit. With how many answers it already has.
 */
async function askableCard(calibration: Awaited<ReturnType<typeof liveCardCalibration>>, userId: string, cardId: string) {
  const card = await db.twinCalibrationCard.findFirst({
    where: {
      id: cardId,
      OR: [{ calibrationId: calibration.id }, { pack: { createdByUserId: userId, status: "open", agentId: calibration.session.agentId } }],
    },
    select: { id: true, packId: true, position: true, topic: true, questionId: true, _count: { select: { ratings: true } } },
  });
  if (!card) throw refusals.notFound();
  return card;
}

/**
 * Asks the twin a card's question (as written, or as she changed it). Returns the reply and the turnIndex to mark it
 * under. Each card is its own conversation with the twin.
 */
export async function askCard(input: { orgId: string; userId: string; calibrationId: string; cardId: string; text: string; own?: boolean }) {
  const calibration = await liveCardCalibration(input.orgId, input.userId, input.calibrationId);
  const text = input.text.trim();
  if (!text) throw refusals.invalidInput("Write what the learner asks");
  const card = await askableCard(calibration, input.userId, input.cardId);
  if (card._count.ratings >= MAX_TURNS_PER_CARD) throw new AppError("card_full", "This card already has its answer.", 409);
  // An unmarked answer (she left before marking it) is asked again under the same index.
  const reply = await askTwinOnCard({ orgId: input.orgId, sessionId: calibration.sessionId, agentSlug: calibration.session.agentSlug, cardId: card.id, text });
  if (input.own && card._count.ratings === 0) await takeOwnQuestion({ orgId: input.orgId, agentId: calibration.session.agentId, card, text });
  return { cardId: card.id, turnIndex: card.position * TURN_STRIDE + card._count.ratings, reply };
}

/**
 * "Ask your own instead": her question takes the card's place in the pack (kept in the pool as hers, asked), and the
 * suggested question it replaced goes back to the pool unasked, for a later pack. Once the twin has answered it.
 */
async function takeOwnQuestion(input: { orgId: string; agentId: string; card: { id: string; questionId: string | null }; text: string }) {
  await db.$transaction(async (tx) => {
    const own = await tx.twinCalibrationQuestion.create({
      data: {
        orgId: input.orgId, agentId: input.agentId, topic: "Your own question", text: input.text.slice(0, 2000),
        source: "Your own question", origin: "own", status: "asked", askedAt: new Date(),
      },
      select: { id: true },
    });
    await tx.twinCalibrationCard.update({ where: { id: input.card.id }, data: { questionId: own.id, topic: "Your own question" } });
    if (input.card.questionId) {
      await tx.twinCalibrationQuestion.updateMany({ where: { id: input.card.questionId, origin: "generated" }, data: { status: "new", askedAt: null } });
    }
  });
}

/**
 * Marks one answer on a card, under this visit; "off" keeps what was off (the `OFF_REASONS` codes) and her own answer. Marking the last
 * answer of a pack completes it.
 */
export async function rateCard(input: {
  orgId: string;
  userId: string;
  calibrationId: string;
  cardId: string;
  turnIndex: number;
  learner: string;
  learnerSource: "suggested" | "edited" | "own";
  reply: string;
  rating: "like" | "off";
  reasons?: string[];
  correction?: string | null;
  correctionAudioKey?: string | null;
  correctionInput?: "typed" | "voice" | null;
}) {
  const calibration = await liveCardCalibration(input.orgId, input.userId, input.calibrationId);
  const card = await askableCard(calibration, input.userId, input.cardId);
  const within = input.turnIndex - card.position * TURN_STRIDE;
  if (within < 0 || within >= MAX_TURNS_PER_CARD) throw refusals.invalidInput("That answer isn't on this card");
  const off = input.rating === "off";
  if (off && input.reasons?.some((reason) => !isOffReason(reason))) throw refusals.invalidInput("Pick what was off");
  const fields = {
    cardId: card.id, question: input.learner, reply: input.reply, rating: input.rating, learnerSource: input.learnerSource,
    reasons: off ? [...new Set(input.reasons ?? [])] : [],
    correction: off ? input.correction?.trim() || null : null,
    correctionAudioKey: off ? input.correctionAudioKey ?? null : null,
    correctionInput: off && input.correction?.trim() ? input.correctionInput ?? "typed" : null,
  };
  await db.twinCalibrationRating.upsert({
    where: { calibrationId_turnIndex: { calibrationId: calibration.id, turnIndex: input.turnIndex } },
    create: { calibrationId: calibration.id, turnIndex: input.turnIndex, ...fields },
    update: fields,
  });
  const complete = card.packId ? await completePackIfDone(card.packId) : false;
  // Completing one of her packs moves her toward a reliable score.
  const score = complete && input.userId === (await calibrationCoach(input.orgId))?.userId ? await twinScore(input.orgId, calibration.session.agentId) : null;
  return { ok: true, packComplete: complete, score };
}

/** A pack is complete once every card's answer is marked. */
async function completePackIfDone(packId: string) {
  const cards = await db.twinCalibrationCard.findMany({ where: { packId }, select: { _count: { select: { ratings: true } } } });
  if (!cards.length || cards.some((card) => card._count.ratings < MAX_TURNS_PER_CARD)) return false;
  await db.twinCalibrationPack.updateMany({ where: { id: packId, status: "open" }, data: { status: "complete", completedAt: new Date() } });
  return true;
}

/**
 * The coach's completed packs of a twin, oldest first, each card with only its first answer (the one that is scored):
 * one query on the packs' (agentId, createdByUserId, status) index, selecting just the verdict, reasons and skill.
 */
function coachPacks(orgId: string, agentId: string, coachId: string) {
  return db.twinCalibrationPack.findMany({
    where: { orgId, agentId, createdByUserId: coachId, status: "complete" },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    select: {
      completedAt: true,
      cards: { select: { question: { select: { source: true } }, ratings: { orderBy: { turnIndex: "asc" }, take: 1, select: { rating: true, reasons: true } } } },
    },
  });
}

/** Answers, likes, per topic (the card's skill) and "What was off?" codes over some of the coach's packs. */
function tally(packs: Awaited<ReturnType<typeof coachPacks>>) {
  const answers = packs.flatMap((pack) => pack.cards.flatMap((card) => (card.ratings[0] ? [{ ...card.ratings[0], topic: card.question?.source ?? "Your own question" }] : [])));
  const topics = [...new Set(answers.map((answer) => answer.topic))].map((topic) => {
    const mine = answers.filter((answer) => answer.topic === topic);
    return { topic, answers: mine.length, liked: mine.filter((answer) => answer.rating === "like").length };
  });
  const reasons = Object.fromEntries(OFF_REASONS.map(({ code }) => [code, answers.filter((answer) => answer.rating === "off" && answer.reasons.includes(code)).length])) as Record<OffReason, number>;
  return { answers: answers.length, liked: answers.filter((answer) => answer.rating === "like").length, topics, reasons };
}

/**
 * The twin's calibration score as coaches see it, from the coach's completed packs (team packs are tests; voice calls
 * don't count): how many are done toward `RELIABLE_PACKS`, her answers and likes, and the accuracy once enough are
 * done (it keeps updating with each later pack). No statistics here: the Wilson interval is for the internal report.
 */
export async function twinScore(orgId: string, agentId: string) {
  const coach = await calibrationCoach(orgId);
  const packs = coach ? await coachPacks(orgId, agentId, coach.userId) : [];
  const { answers, liked } = tally(packs);
  const reliable = packs.length >= RELIABLE_PACKS;
  return {
    packsDone: packs.length,
    target: RELIABLE_PACKS,
    reliable,
    answers,
    liked,
    accuracy: reliable && answers ? Math.round((liked / answers) * 100) : null,
  };
}

/**
 * The twin's score after each of the coach's completed packs, for the internal report (worked out from the packs,
 * nothing stored): packs done, answers, likes, the Wilson 95% interval, reliable, per topic and "What was off?".
 */
export async function twinScoreHistory(orgId: string, agentId: string) {
  const coach = await calibrationCoach(orgId);
  const packs = coach ? await coachPacks(orgId, agentId, coach.userId) : [];
  return packs.map((pack, i) => {
    const score = tally(packs.slice(0, i + 1));
    return { packsDone: i + 1, completedAt: pack.completedAt, ...score, wilson: wilson(score.liked, score.answers), reliable: i + 1 >= RELIABLE_PACKS };
  });
}
