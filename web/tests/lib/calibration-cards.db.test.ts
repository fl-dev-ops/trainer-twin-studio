import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as reportModel from "@/lib/report-model";
import { askCard, rateCard, startCardCalibration, twinScore, twinScoreHistory } from "@/lib/twin/calibration-cards";
import { twinRouter } from "@/lib/twin/trpc";
import { readCalibration } from "@/workflows/steps/calibration";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Card calibrations (migration 20261119120000_calibration_cards): storage, its CHECKs, and the twin-session mode rule.
describe.skipIf(!localMinutesDb)("card calibration storage (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => {
    await db.twinCalibrationQuestion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  const twinSession = (fields: { mode: "voice" | "chat"; userId?: string }) => ({
    orgId: f.org.id, userId: fields.userId ?? f.trainer.id, agentId: f.twin.id, shareCode: randomUUID(),
    personaSlug: f.org.id, personaVersion: 1, agentSlug: f.twin.slug, agentVersion: 1,
    status: "active", allowedSeconds: 600, mode: fields.mode,
  });
  /** Prisma's lazy query, run, so expect().rejects sees a real promise. */
  const run = (query: PromiseLike<unknown>) => Promise.resolve(query);
  /** A text calibration: the session and its calibration in one transaction, as lib/interview-sessions.ts does. */
  const textCalibration = () => db.$transaction(async (tx) => {
    const session = await tx.interviewSession.create({ data: twinSession({ mode: "chat" }) });
    return tx.twinCalibration.create({ data: { sessionId: session.id, createdByUserId: f.trainer.id } });
  });

  test("a text twin session is refused unless it is a calibration", async () => {
    await expect(run(db.interviewSession.create({ data: twinSession({ mode: "chat" }) }))).rejects.toThrow(/voice only/);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
    const calibration = await textCalibration();
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: calibration.sessionId } })).toMatchObject({ mode: "chat" });
  });

  test("a voice twin session for staff still needs no calibration", async () => {
    await db.interviewSession.create({ data: twinSession({ mode: "voice" }) });
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(1);
  });

  test("questions, cards and rated replies keep the coach's reasons and her own answer", async () => {
    const calibration = await textCalibration();
    const question = await db.twinCalibrationQuestion.create({ data: {
      orgId: f.org.id, agentId: f.twin.id, topic: "Client says it is too expensive",
      text: "My client says 3% commission is too much. What do I say?", source: "Skill situation", origin: "generated",
    } });
    const card = await db.twinCalibrationCard.create({ data: {
      calibrationId: calibration.id, questionId: question.id, position: 0, topic: question.topic, agentVersion: 1,
    } });
    await db.twinCalibrationRating.create({ data: {
      calibrationId: calibration.id, cardId: card.id, turnIndex: 0, question: question.text, reply: "Explain your value…",
      rating: "off", learnerSource: "suggested", reasons: ["Not my method", "Too long"],
      correction: "First ask: too much compared to what?", correctionAudioKey: "calibration/audio.webm", correctionInput: "voice",
    } });
    expect(await db.twinCalibrationCard.findUniqueOrThrow({ where: { id: card.id }, include: { ratings: true, question: true } })).toMatchObject({
      question: { status: "new" },
      ratings: [{ rating: "off", reasons: ["Not my method", "Too long"], correction: "First ask: too much compared to what?", correctionInput: "voice" }],
    });
    // Voice-call ratings leave the new fields empty.
    expect(await db.twinCalibrationRating.create({ data: { calibrationId: calibration.id, turnIndex: 1, reply: "Hi!", rating: "like" } }))
      .toMatchObject({ cardId: null, reasons: [], correction: null, learnerSource: null });
  });

  test("CHECKs refuse unknown sources, inputs, origins and statuses", async () => {
    const calibration = await textCalibration();
    const rating = { calibrationId: calibration.id, reply: "r", rating: "like" };
    await expect(run(db.twinCalibrationRating.create({ data: { ...rating, turnIndex: 0, learnerSource: "ai" } }))).rejects.toThrow();
    await expect(run(db.twinCalibrationRating.create({ data: { ...rating, turnIndex: 1, correctionInput: "video" } }))).rejects.toThrow();
    const question = { orgId: f.org.id, agentId: f.twin.id, topic: "t", text: "q", source: "s" };
    await expect(run(db.twinCalibrationQuestion.create({ data: { ...question, origin: "copied" } }))).rejects.toThrow();
    await expect(run(db.twinCalibrationQuestion.create({ data: { ...question, origin: "own", status: "done" } }))).rejects.toThrow();
    await expect(run(db.twinCalibrationCard.create({ data: { calibrationId: calibration.id, position: -1, topic: "t", agentVersion: 1 } }))).rejects.toThrow();
  });
});

describe.skipIf(!localMinutesDb)("calibration packs (local database)", () => {
  let f: MinutesFixture;
  let fetching: ReturnType<typeof spyOn>;
  let model: ReturnType<typeof spyOn>;
  const replies: string[] = [];
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    process.env.COPILOT_SERVICE_SECRET ??= "test-secret";
    replies.length = 0;
    // The chat service: session set-up answers 204; each completion streams the next queued reply.
    fetching = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (!String(url).includes("/v1/chat/completions")) return new Response(null, { status: 204 });
      const content = replies.shift() ?? "…";
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    });
    model = spyOn(reportModel, "callReportModel").mockResolvedValue(JSON.stringify({ questions: [] }));
  });
  afterEach(async () => {
    fetching.mockRestore(); model.mockRestore();
    await db.twinCalibrationPack.deleteMany({ where: { orgId: f.org.id } });
    await db.twinCalibrationQuestion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });

  const coach = () => ({ id: f.trainer.id, name: f.trainer.name, email: f.trainer.email });
  const questions = (texts: string[]) => db.twinCalibrationQuestion.createMany({ data: texts.map((text, i) => ({
    orgId: f.org.id, agentId: f.twin.id, topic: `Situation ${i}`, text, source: "Objection Handling", origin: "generated",
  })) });
  test("a pack carries over between visits until every card's answer is marked", async () => {
    await questions(["3% is too much?", "Client went silent?"]);
    const first = await startCardCalibration({ orgId: f.org.id, user: coach(), slug: f.twin.slug });
    expect(await readCalibration(first.sessionId)).toBe("ready"); // text: no voice transcript to wait for
    expect(first.pack.cards.map((card) => card.question)).toEqual(["3% is too much?", "Client went silent?"]);
    expect(await db.twinCalibrationQuestion.count({ where: { agentId: f.twin.id, status: "asked" } })).toBe(2);
    const [card1, card2] = first.pack.cards;

    // Card 1: asked (with a file, as on a call), marked off with her own answer.
    const base = { orgId: f.org.id, userId: f.trainer.id, calibrationId: first.calibrationId, cardId: card1.id };
    replies.push("Offer a small discount.");
    const learner = `I've attached a file: chat.png [ATTACHED doc-1]\n${card1.question}`;
    const asked = await askCard({ ...base, text: learner });
    expect(asked).toMatchObject({ turnIndex: 0, reply: "Offer a small discount." });
    const [call] = fetching.mock.calls.filter(([url]: [unknown]) => String(url).includes("/v1/chat/completions"));
    expect((call[1] as RequestInit).headers).toMatchObject({ "x-trainertwin-conversation-id": card1.id, "x-trainertwin-mode": "chat" });
    expect(JSON.parse(String((call[1] as RequestInit).body)).messages[0].content).toContain("[ATTACHED doc-1]");
    const offRating = { ...base, turnIndex: 0, learner, learnerSource: "suggested" as const, reply: asked.reply, rating: "off" as const };
    // Only the "What was off?" codes are kept (an old label is refused).
    await expect(rateCard({ ...offRating, reasons: ["Too generic"] })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await rateCard({ ...offRating, reasons: ["advice", "style", "advice"], correction: "First ask: compared to what?", correctionInput: "typed" }))
      .toMatchObject({ packComplete: false });
    // One answer per card: asking again is refused.
    await expect(askCard({ ...base, text: "And then?" })).rejects.toMatchObject({ code: "card_full" });

    // A later visit (the first's session ended): the same pack, card 1 as she left it, card 2 still to ask.
    await db.interviewSession.update({ where: { id: first.sessionId }, data: { status: "abandoned", endedAt: new Date() } });
    const second = await startCardCalibration({ orgId: f.org.id, user: coach(), slug: f.twin.slug });
    expect(second.pack.id).toBe(first.pack.id);
    expect(second.pack.cards[0].turns).toMatchObject([{ rating: "off", reasons: ["advice", "style"], correction: "First ask: compared to what?", source: "suggested" }]);
    expect(second.pack.cards[1].turns).toEqual([]);
    await expect(askCard({ ...base, cardId: card2.id, text: "Old visit?" })).rejects.toMatchObject({ code: "calibration_ended" });

    // Card 2, reworded: the last answer completes the pack.
    replies.push("Send one short question.");
    const card2Base = { orgId: f.org.id, userId: f.trainer.id, calibrationId: second.calibrationId, cardId: card2.id };
    const reworded = await askCard({ ...card2Base, text: "My lead went quiet after the viewing?" });
    expect(await rateCard({ ...card2Base, turnIndex: reworded.turnIndex, learner: "My lead went quiet after the viewing?", learnerSource: "edited", reply: reworded.reply, rating: "like" }))
      .toMatchObject({ packComplete: true, score: { packsDone: 1, target: 6, reliable: false, answers: 2, liked: 1, accuracy: null } });
    expect(await db.twinCalibrationPack.findUniqueOrThrow({ where: { id: first.pack.id } })).toMatchObject({ status: "complete" });
    // The internal report's history, worked out from the packs: 1 of 2 first answers liked, with its Wilson interval.
    const [after1] = await twinScoreHistory(f.org.id, f.twin.id);
    expect(after1).toMatchObject({ packsDone: 1, answers: 2, liked: 1, reliable: false, reasons: { advice: 1, facts: 0, style: 1, scope: 0 } });
    expect([after1.wilson!.low, after1.wilson!.high].map((x) => +x.toFixed(4))).toEqual([0.0945, 0.9055]);

    // Reviewed as one pack: 2 answers, 1 off; its visits aren't rows of their own.
    const caller = twinRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
    expect(await caller.calibrations.get({ id: first.pack.id })).toMatchObject({ score: { turns: 2, off: 1 } });
    const listed = await caller.calibrations.list({ slug: f.twin.slug });
    expect(listed.calibrations.map((row) => row.id)).toEqual([first.pack.id]);
    expect(listed.score).toEqual({ packsDone: 1, target: 6, reliable: false, answers: 2, liked: 1, accuracy: null });

    // All questions used: a new pack has nothing to ask yet.
    await expect(startCardCalibration({ orgId: f.org.id, user: coach(), slug: f.twin.slug })).rejects.toMatchObject({ code: "no_questions" });
  });

  test("her own question takes the card's place, and the suggested one goes back to the pool unasked", async () => {
    await questions(["3% is too much?"]);
    const started = await startCardCalibration({ orgId: f.org.id, user: coach(), slug: f.twin.slug });
    const [card] = started.pack.cards;
    const suggested = await db.twinCalibrationQuestion.findFirstOrThrow({ where: { agentId: f.twin.id, text: "3% is too much?" } });
    replies.push("Ask what they're comparing it to.");
    await askCard({ orgId: f.org.id, userId: f.trainer.id, calibrationId: started.calibrationId, cardId: card.id, text: "My client wants 2% or walks. Now what?", own: true });
    const now = await db.twinCalibrationCard.findUniqueOrThrow({ where: { id: card.id }, select: { topic: true, question: { select: { text: true, origin: true, status: true } } } });
    expect(now).toMatchObject({ topic: "Your own question", question: { text: "My client wants 2% or walks. Now what?", origin: "own", status: "asked" } });
    expect(await db.twinCalibrationQuestion.findUniqueOrThrow({ where: { id: suggested.id } })).toMatchObject({ status: "new", askedAt: null });
    // A later visit shows the card with her question.
    await db.interviewSession.update({ where: { id: started.sessionId }, data: { status: "abandoned", endedAt: new Date() } });
    const again = await startCardCalibration({ orgId: f.org.id, user: coach(), slug: f.twin.slug });
    expect(again.pack.cards[0]).toMatchObject({ question: "My client wants 2% or walks. Now what?", skill: "Your own question" });
  });

  test("the coach's packs count; a team member's pack is a test, listed with her name but not counted", async () => {
    // A team member of the org (Cathy) besides the admin coach (the fixture's trainer).
    const teamId = `${f.org.id}-team`;
    await db.user.create({ data: { id: teamId, name: "Cathy", email: `${teamId}@example.com`, emailVerified: true } });
    await db.member.create({ data: { id: `${teamId}-member`, userId: teamId, organizationId: f.org.id, role: "team", createdAt: new Date() } });
    const answerFirst = async (user: { id: string; name: string; email: string }, rating: "like" | "off") => {
      const started = await startCardCalibration({ orgId: f.org.id, user, slug: f.twin.slug });
      const card = started.pack.cards[0];
      replies.push("An answer.");
      const asked = await askCard({ orgId: f.org.id, userId: user.id, calibrationId: started.calibrationId, cardId: card.id, text: card.question });
      await rateCard({ orgId: f.org.id, userId: user.id, calibrationId: started.calibrationId, cardId: card.id, turnIndex: asked.turnIndex, learner: card.question, learnerSource: "suggested", reply: asked.reply, rating });
      return started;
    };
    await questions(["3% is too much?"]);
    const mine = await answerFirst(coach(), "like");
    expect(mine.teamTest).toBeNull();
    await questions(["Client went silent?"]);
    const team = await answerFirst({ id: teamId, name: "Cathy", email: `${teamId}@example.com` }, "off");
    expect(team.teamTest).toMatchObject({ coachName: f.trainer.name });

    const caller = twinRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
    const rows = (await caller.calibrations.list({ slug: f.twin.slug })).calibrations;
    expect(rows.map((row) => ({ id: row.id, by: row.by, counts: row.counts })).sort((a, b) => Number(b.counts) - Number(a.counts))).toEqual([
      { id: mine.pack.id, by: f.trainer.name, counts: true },
      { id: team.pack.id, by: "Cathy", counts: false },
    ]);
    // The twin's "Feels like me" weeks count the coach's answer only: 1 of 1 liked, not 1 of 2.
    const twin = await caller.agents.get({ slug: f.twin.slug });
    expect(twin.report.feelsLikeMe.at(-1)).toBe(100);
  });

  test("only the pack's coach asks on its cards", async () => {
    await questions(["3% is too much?"]);
    const started = await startCardCalibration({ orgId: f.org.id, user: coach(), slug: f.twin.slug });
    await expect(askCard({ orgId: f.org.id, userId: f.learner.id, calibrationId: started.calibrationId, cardId: started.pack.cards[0].id, text: "Hi?" }))
      .rejects.toMatchObject({ code: "not_found" });
  });
  test("the score is reliable after 6 of the coach's packs and updates with each later one; a team member's packs don't count", async () => {
    // A text visit the answers hang off (each answer keeps the visit it was given in).
    const calibration = await db.$transaction(async (tx) => {
      const session = await tx.interviewSession.create({ data: {
        orgId: f.org.id, userId: f.trainer.id, agentId: f.twin.id, shareCode: randomUUID(), personaSlug: f.org.id, personaVersion: 1,
        agentSlug: f.twin.slug, agentVersion: 1, status: "active", allowedSeconds: 600, mode: "chat",
      } });
      return tx.twinCalibration.create({ data: { sessionId: session.id, createdByUserId: f.trainer.id } });
    });
    const teamId = `${f.org.id}-team`;
    await db.user.create({ data: { id: teamId, name: "Cathy", email: `${teamId}@example.com`, emailVerified: true } });
    await db.member.create({ data: { id: `${teamId}-member`, userId: teamId, organizationId: f.org.id, role: "team", createdAt: new Date() } });
    /** A completed pack of 10 first answers, `liked` of them Feels like me. */
    let turn = 0;
    const pack = async (liked: number, by = f.trainer.id, at = new Date()) => {
      const made = await db.twinCalibrationPack.create({ data: { orgId: f.org.id, agentId: f.twin.id, createdByUserId: by, status: "complete", completedAt: at } });
      for (let i = 0; i < 10; i++) {
        const card = await db.twinCalibrationCard.create({ data: { packId: made.id, position: i, topic: "Price", agentVersion: 1 } });
        await db.twinCalibrationRating.create({ data: { calibrationId: calibration.id, cardId: card.id, turnIndex: turn++ * 100, reply: "…", rating: i < liked ? "like" : "off" } });
      }
    };
    for (let i = 0; i < 5; i++) await pack(8, f.trainer.id, new Date(Date.UTC(2026, 10, 1 + i)));
    await pack(10, teamId, new Date(Date.UTC(2026, 10, 6)));
    expect(await twinScore(f.org.id, f.twin.id)).toEqual({ packsDone: 5, target: 6, reliable: false, answers: 50, liked: 40, accuracy: null });
    await pack(8, f.trainer.id, new Date(Date.UTC(2026, 10, 7)));
    expect(await twinScore(f.org.id, f.twin.id)).toEqual({ packsDone: 6, target: 6, reliable: true, answers: 60, liked: 48, accuracy: 80 });
    // A later pack updates it: 48 of 70.
    await pack(0, f.trainer.id, new Date(Date.UTC(2026, 10, 8)));
    expect(await twinScore(f.org.id, f.twin.id)).toEqual({ packsDone: 7, target: 6, reliable: true, answers: 70, liked: 48, accuracy: 69 });
    // The report's history: one row per coach pack (the team's left out), reliable from the 6th, 48 of 60 → 68%–88%.
    const history = await twinScoreHistory(f.org.id, f.twin.id);
    expect(history.map((row) => row.packsDone)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(history.map((row) => row.reliable)).toEqual([false, false, false, false, false, true, true]);
    expect([history[5].wilson!.low, history[5].wilson!.high].map((x) => +x.toFixed(3))).toEqual([0.682, 0.882]);
  });
});
