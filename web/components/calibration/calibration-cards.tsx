"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, ChevronRight, Info, LoaderCircle, Mic, Paperclip, Square, Volume2, VolumeX, X } from "lucide-react";
import { toast } from "sonner";
import { MessageFileCard } from "@/components/copilot-composer";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WhyButton, WhyPanel, useEvidenceTurns } from "@/components/calibration/why-panel";
import { generateSpeech, playPcmStream, stopPlayback } from "@/lib/audio-playback";
import { DURING_UPLOAD_ACCEPT, DURING_UPLOAD_RULE, duringUploadProblem } from "@/lib/context-upload";
import { stripAttachments } from "@/lib/markers";
import { lookupEvidence } from "@/lib/twin/evidence-match";
import type { TurnEvidence } from "@/lib/twin/evidence";
import { attachedMessage, uploadFile } from "@/lib/upload-client";
import { twinClient } from "@/lib/twin/client";
import { OFF_REASONS, offReasonLabel } from "@/lib/twin/calibration-reasons";
import { cn } from "@/lib/utils";

/**
 * Calibrate (calibration v2), as the TT_Shyam_v26Oct prototype's "Does it sound like you?" (signup.js suCalChat), in
 * packs: the coach's open pack (10 questions, one answer each) carries over between visits, so she picks up where she
 * left. She asks each card's question (as written or in her own words) and her twin answers, read aloud in its own
 * voice (and shown). Each answer is marked Feels like me or Feels off; Feels off asks what was off and what she would
 * say instead (typed, or spoken: the recording is kept). The next question comes once the answer is marked. Each
 * answer's buttons show once it has been heard. The meter has a segment per answer. Every card starts the twin fresh.
 */

/** Learner lines per card: its question only. */
const MAX_TURNS = 1;
const VOICE_PREF = "calibrate-voice";

type Source = "suggested" | "edited" | "own";
type Turn = {
  learner: string;
  source: Source;
  reply?: string;
  turnIndex?: number;
  rating?: "like" | "off";
  reasons?: string[];
  correction?: string | null;
};
/** A file attached to a learner line (a screenshot of a WhatsApp chat, a PDF), linked to the calibration's session. */
type Attachment = { id: string; name: string; mediaType: string | null };
/** One of the pack's cards: its question, then what was asked with the twin's answer and its mark. */
type Card = { key: string; id: string; question: string; skill: string; topic: string; turns: Turn[] };
type OffDraft = { cardKey: string; reasons: string[]; text: string; audioKey: string | null; input: "typed" | "voice"; files: Attachment[] };

/**
 * A file attached during calibration, as on a call: uploaded, then linked to the visit's session (the twin, and the
 * review, read it by id). Throws with the reason when the file or the link is refused.
 */
async function uploadToSession(sessionId: string, file: File): Promise<Attachment> {
  const problem = duringUploadProblem(file);
  if (problem) throw new Error(problem);
  const doc = await uploadFile(file, { purpose: "during" });
  const linked = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: doc.id }),
  });
  const result = (await linked.json().catch(() => null)) as { error?: string } | null;
  if (!linked.ok) throw new Error(result?.error ?? "Could not attach the file");
  return { id: doc.id, name: doc.name, mediaType: file.type || null };
}

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong. Try again.");
const readVoicePref = () => {
  try {
    return localStorage.getItem(VOICE_PREF) !== "off";
  } catch {
    return true;
  }
};

export function CalibrationCards({ slug, attach = false }: { slug: string; attach?: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [calibrationId, setCalibrationId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(readVoicePref);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  /** A team member's pack is a test: saved, not counted toward the coach's accuracy. */
  const [teamTest, setTeamTest] = useState<{ coachName: string } | null>(null);
  // The coach's packs toward a reliable score (null for a team member, whose packs don't count).
  const [score, setScore] = useState<TwinScore | null>(null);
  /** The pack's cards in order: asked ones with their answers, the rest still to ask. */
  const [cards, setCards] = useState<Card[]>([]);
  const [busy, setBusy] = useState(false);
  /** The next question, as she may reword it before asking. */
  /** The next question as she'll ask it: the suggested one with files attached, or her own instead (`own`). */
  const [draft, setDraft] = useState<{ cardId: string; text: string; files?: Attachment[]; own?: boolean; listen?: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  /** "Why this answer", as on a call: what the twin heard and looked up for an answer of this visit. */
  const evidenceTurns = useEvidenceTurns(sessionId, 3000);
  const [whyFor, setWhyFor] = useState<{ id: string; evidence: TurnEvidence } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [off, setOff] = useState<OffDraft | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [openEarlier, setOpenEarlier] = useState<string | null>(null);
  /** Files attached on this page, by upload id: a learner line shows them as file cards above its text. */
  const [attached, setAttached] = useState<Map<string, Attachment>>(new Map());
  const finishedRef = useRef(false);
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const update = (key: string, change: (card: Card) => Card) => setCards((all) => all.map((card) => (card.key === key ? change(card) : card)));

  /** The answer being read aloud (`${card key}:${turn}`); its Feels like me / Feels off wait until it has been heard. */
  const [speaking, setSpeaking] = useState<string | null>(null);
  /** Reads an answer aloud in the twin's voice, to the end; a new one stops the last. Text stays on screen either way. */
  const speak = useCallback(async (id: string, text: string) => {
    if (!voice) return;
    stopPlayback();
    setSpeaking(id);
    try {
      await playPcmStream(await generateSpeech(voice, text), { untilEnd: true });
    } catch {
      toast.error("Couldn't play your twin's voice. The answer is on screen.");
    } finally {
      setSpeaking((current) => (current === id ? null : current));
    }
  }, [voice]);
  const stopSpeaking = () => {
    stopPlayback();
    setSpeaking(null);
  };
  const toggleVoice = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    if (!next) stopSpeaking();
    try {
      localStorage.setItem(VOICE_PREF, next ? "on" : "off");
    } catch {
      // Private window: the choice lasts this visit.
    }
  };
  useEffect(() => () => stopPlayback(), []);

  /** A visit: its text session, and her open pack (a new one once the last is complete), carried on where she left. */
  const start = async () => {
    setStarting(true);
    try {
      const started = await twinClient.calibrations.cards.start.mutate({ slug });
      finishedRef.current = false;
      setCalibrationId(started.calibrationId);
      setSessionId(started.sessionId);
      setVoice(started.voice);
      setPackId(started.pack.id);
      setTeamTest(started.teamTest);
      setScore(started.score);
      const restored = started.pack.cards.map((card) => ({
        key: card.id, id: card.id, question: card.question, skill: card.skill, topic: card.topic, turns: card.turns,
      }));
      setCards(restored);
      setStartError(null);
    } catch (error) {
      setStartError(message(error));
    } finally {
      setStarting(false);
    }
  };

  // One visit per page load (a strict-mode double run must not start two).
  const startRef = useRef(start);
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startRef.current();
  }, []);

  /** Ends this visit's session with its answers as the transcript; the pack stays open for next time. */
  const finalize = useCallback((status: "completed" | "abandoned", unloading = false) => {
    if (!sessionId || finishedRef.current) return Promise.resolve(true);
    finishedRef.current = true;
    const transcript = cardsRef.current.flatMap((card) => card.turns.flatMap((turn) => [
      { role: "user", text: turn.learner },
      ...(turn.reply ? [{ role: "trainer", text: turn.reply }] : []),
    ]));
    return fetch("/api/sessions/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, status, transcript }),
      keepalive: unloading,
    }).then((response) => response.ok, () => false);
  }, [sessionId]);

  // Leaving the page ends the visit; every marked answer is already saved on the pack.
  useEffect(() => {
    const leave = () => void finalize("abandoned", true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [finalize]);

  /** Her pack's results (the review page reads a pack by its id). */
  const finish = async () => {
    stopSpeaking();
    setFinishing(true);
    await finalize("completed");
    void queryClient.invalidateQueries();
    if (packId) router.replace(`/twin/${encodeURIComponent(slug)}/calibration/${encodeURIComponent(packId)}`);
  };

  /** A card is complete once its answer is marked; the next question waits until then. */
  const complete = (card: Card) => card.turns.length >= MAX_TURNS && card.turns.every((turn) => turn.rating);
  const done = cards.filter(complete);
  /** The card in progress: asked and not complete. */
  const current = cards.find((card) => card.turns.length > 0 && !complete(card));
  /** The next card to ask, once nothing is in progress. */
  const next = current ? undefined : cards.find((card) => card.turns.length === 0);
  const packComplete = cards.length > 0 && cards.every(complete);

  /** Asks the twin a card's question (or her rewording). */
  const ask = async (input: { card: Card; text: string; source: Source; files?: Attachment[] }) => {
    const own = input.source === "own";
    if (!calibrationId) return;
    // Attached files ride in the learner's line as markers; the chat bridge hands the twin the files themselves
    // (chat/agent/channels/openai-compat.ts), as on a call.
    const files = input.files ?? [];
    const learner = [...files.map((file) => attachedMessage(file)), input.text].filter(Boolean).join("\n");
    const key = input.card.key;
    const turnNumber = input.card.turns.length;
    // Her own question takes the card's place: shown as hers from now on.
    update(key, (card) => ({
      ...card, ...(own ? { question: input.text, skill: "Your own question", topic: "" } : {}),
      turns: [...card.turns, { learner, source: input.source }],
    }));
    setBusy(true);
    try {
      const answered = await twinClient.calibrations.cards.ask.mutate({ calibrationId, cardId: input.card.id, text: learner, ...(own ? { own: true } : {}) });
      update(key, (card) => ({
        ...card,
        turns: card.turns.map((t, i) => (i === card.turns.length - 1 ? { ...t, reply: answered.reply, turnIndex: answered.turnIndex } : t)),
      }));
      // Heard first, as a learner would: read aloud in the twin's voice.
      if (voiceOn) void speak(`${key}:${turnNumber}`, answered.reply);
    } catch (error) {
      toast.error(message(error));
      // Nothing was saved for this line: take it back, with its files, to ask again.
      update(key, () => ({ ...input.card }));
      setDraft({ cardId: input.card.id, text: input.text, files, own });
    } finally {
      setBusy(false);
    }
  };

  const rate = async (card: Card, turn: Turn, rating: "like" | "off", draftOff?: OffDraft) => {
    if (!calibrationId || turn.turnIndex === undefined || !turn.reply) return;
    const correction = draftOff ? [...draftOff.files.map((file) => attachedMessage(file)), draftOff.text.trim()].filter(Boolean).join("\n") || null : null;
    setBusy(true);
    try {
      const rated = await twinClient.calibrations.cards.rate.mutate({
        calibrationId, cardId: card.id, turnIndex: turn.turnIndex, learner: turn.learner, learnerSource: turn.source, reply: turn.reply, rating,
        ...(draftOff ? { reasons: draftOff.reasons, correction, correctionAudioKey: draftOff.audioKey, correctionInput: correction ? draftOff.input : null } : {}),
      });
      update(card.key, (c) => ({
        ...c, turns: c.turns.map((t) => (t.turnIndex === turn.turnIndex ? { ...t, rating, reasons: draftOff?.reasons, correction } : t)),
      }));
      if (rated.score) setScore(rated.score);
      setOff(null);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  };

  // The meter: one slot per card of the pack (its answer), in order, then each skill's
  // liked / marked answers ("not tested yet").
  type Slot = "like" | "off" | undefined;
  const slots: Slot[] = cards.map((card) => card.turns[0]?.rating);
  const total = cards.length * MAX_TURNS;
  const answers = cards.flatMap((card) => (card.turns[0]?.rating ? [{ rating: card.turns[0].rating, skill: card.skill, reasons: card.turns[0].reasons ?? [] }] : []));
  const liked = answers.filter((answer) => answer.rating === "like").length;
  const bySkill = [...new Set(cards.map((card) => card.skill))].map((name) => {
    const mine = answers.filter((answer) => answer.skill === name);
    return { name, ok: mine.filter((answer) => answer.rating === "like").length, n: mine.length };
  });
  const allTested = bySkill.length > 0 && bySkill.every((skill) => skill.n > 0);
  const soundsLikeYou = answers.length >= 5 && liked >= Math.ceil(answers.length * 0.8) && allTested;
  // More material only helps when the facts were off: shown once at least two answers felt off and most of them were
  // marked "The facts" (the advice, how it's said or the scope are fixed elsewhere, at review).
  const offAnswers = answers.filter((answer) => answer.rating === "off");
  const factsOff = offAnswers.filter((answer) => answer.reasons.includes("facts")).length;
  const needsMaterial = offAnswers.length >= 2 && factsOff > offAnswers.length / 2;
  const slotColour = (slot: Slot) => (slot === "like" ? "bg-success" : slot === "off" ? "bg-caution" : "bg-muted");

  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [cards, off]);

  if (startError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="m-0 text-sm text-muted-foreground">{startError}</p>
        <Link href={`/twin/${encodeURIComponent(slug)}`} className="text-sm font-semibold text-brand-strong underline-offset-2 hover:underline">Back to the twin</Link>
      </div>
    );
  }

  /**
   * A file for the next question (a screenshot of the client's WhatsApp, a PDF), as on a call: uploaded, linked to this
   * visit's session (the twin reads it by id), then held in the question's box until she asks.
   */
  const attachFile = async (card: Card, file: File) => {
    if (!sessionId) return;
    setUploading(true);
    try {
      const attachment = await uploadToSession(sessionId, file);
      setAttached((map) => new Map(map).set(attachment.id, attachment));
      setDraft((current) => ({
        cardId: card.id,
        text: current?.cardId === card.id ? current.text : card.question,
        files: [...(current?.cardId === card.id ? current.files ?? [] : []), attachment],
        own: current?.cardId === card.id ? current.own : false,
      }));
    } catch (error) {
      toast.error(message(error));
    } finally {
      setUploading(false);
    }
  };

  /** Where the card in progress stands, for the line under it: what's happening, or what she does next. */
  const stepLine = (card: Card): { text: string; busy?: boolean } => {
    const index = card.turns.length - 1;
    const last = card.turns[index];
    if (last.reply === undefined) return { text: "Your twin is answering…", busy: true };
    if (speaking === `${card.key}:${index}`) return { text: "Your twin is speaking…", busy: true };
    return { text: off?.cardKey === card.key ? "What felt off?" : "How did that answer feel?" };
  };

  const bubble = "max-w-[88%] rounded-xl px-3 py-2.5 text-sm leading-5 whitespace-pre-wrap";

  /** Files on a line (her question's, or her answer's): file cards, an image opening full size (Fix 1). */
  const fileCards = (files: { id: string; name: string }[], side: "start" | "end") =>
    files.length ? (
      <div className={cn("flex flex-wrap gap-2", side === "end" ? "justify-end" : "justify-start")}>
        {files.map((file) => {
          const known = attached.get(file.id);
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
    ) : null;

  /** One card: the question in brand orange, the twin's answer, then its mark (or the buttons). */
  const cardBody = (card: Card) => (
    <>
      {card.turns.map((turn, i) => {
        const split = stripAttachments(turn.learner);
        return (
          <div key={i} className="flex flex-col gap-2">
            {fileCards(split.files, "end")}
            <div className={cn(bubble, "self-end rounded-br-sm bg-brand text-white", !split.text && "hidden")}>
              {split.text}
              {/* A second line only on old packs that had follow-ups. */}
              <small className="mt-0.5 block text-xs opacity-75">{i === 0 ? (card.topic ? `${card.skill} · ${card.topic}` : card.skill) : "Follow-up"}</small>
            </div>
            {turn.reply === undefined ? (
              <div className="flex w-max gap-1 rounded-xl rounded-bl-sm bg-muted px-3 py-3.5" role="status" aria-label="Your twin is answering">
                {[0, 1, 2].map((dot) => <span key={dot} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />)}
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <div className={cn(bubble, "rounded-bl-sm bg-muted", turn.correction && "line-through opacity-55")}>{turn.reply}</div>
                  {(() => {
                    // Shown when the twin looked something up for this answer (this visit's answers only).
                    const evidence = lookupEvidence(evidenceTurns ?? [], turn.reply);
                    const id = `${card.key}:${i}`;
                    return evidence ? <WhyButton open={whyFor?.id === id} onClick={() => setWhyFor(whyFor?.id === id ? null : { id, evidence })} /> : null;
                  })()}
                </div>
                {turn.correction ? (
                  <>
                    {fileCards(stripAttachments(turn.correction).files, "start")}
                    {stripAttachments(turn.correction).text ? (
                      <div className={cn(bubble, "rounded-bl-sm bg-muted")}>
                        <small className="mb-0.5 block text-xs font-bold text-success">Your answer</small>
                        {stripAttachments(turn.correction).text}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {turn.rating ? (
                  <p className={cn("m-0 text-sm font-bold", turn.rating === "like" ? "text-success" : "text-caution")}>
                    {turn.rating === "like" ? "✓ Feels like me" : `Feels off${turn.reasons?.length ? ` · ${turn.reasons.map(offReasonLabel).join(", ")}` : ""}`}
                  </p>
                ) : speaking === `${card.key}:${i}` ? null /* marked once heard: the buttons wait for the voice to end */ : off?.cardKey === card.key ? (
                  <OffBox
                    draft={off}
                    calibrationId={calibrationId!}
                    busy={busy}
                    onChange={setOff}
                    onCancel={() => setOff(null)}
                    onSave={(draftOff) => void rate(card, turn, "off", draftOff)}
                    attach={attach && sessionId ? { sessionId, onKnown: (file) => setAttached((map) => new Map(map).set(file.id, file)) } : undefined}
                  />
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void rate(card, turn, "like")}>Feels like me</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOff({ cardKey: card.key, reasons: [], text: "", audioKey: null, input: "typed", files: [] })}>Feels off</Button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );

  return (
    // A studio page (the left navigation stays); only the call (`/calibrate/call`) is full screen.
    <PageContainer className="flex max-w-[760px] flex-col gap-4">
      {/* Back to the twin's calibrations, where Calibrate is opened from: there whether or not she has started
          (Finish needs an answer). */}
      <Link href={`/twin/${encodeURIComponent(slug)}/calibration`} className="inline-flex items-center gap-2 self-start text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Calibrations
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="m-0 text-lg font-semibold tracking-title">Does it sound like you?</h1>
        <div className="flex items-center gap-3">
          {/* "Prefer to talk? Calibrate on a call" (/calibrate/call) is hidden for now; the call page still works. */}
          <Button size="sm" variant="ghost" onClick={toggleVoice} aria-pressed={voiceOn} disabled={!voice}>
            {voiceOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            {voiceOn ? "Voice on" : "Voice off"}
          </Button>
          <Button size="sm" variant="secondary" disabled={finishing || !packId || busy || !answers.length} onClick={() => void finish()}>
            {finishing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
            Finish
          </Button>
        </div>
      </div>
      <p className="m-0 -mt-3 text-sm text-muted-foreground">Questions your learners are likely to ask from your Twin.</p>
      {teamTest ? (
        <p className="m-0 -mt-2 text-xs text-muted-foreground">
          Team test: your answers are saved but don&apos;t count toward {teamTest.coachName.split(/\s+/)[0]}&apos;s accuracy.
        </p>
      ) : null}

      {score ? <ScoreRing score={score} /> : null}

      {/* Meter: the pack's answers, one per card. */}
      <div className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5">
        <b className="text-sm">
          {!total ? "Getting your questions ready…" : `Answer ${answers.length} of ${total}${answers.length ? ` · Feels like me: ${liked} of ${answers.length}` : ""}`}
        </b>
        {/* One segment per card's answer, in order. */}
        <span className="flex gap-1" aria-hidden>
          {Array.from({ length: total || 20 }, (_, i) => <i key={i} className={cn("h-2 flex-1 rounded", slotColour(slots[i]))} />)}
        </span>
        {bySkill.length ? (
          <small className="text-xs text-muted-foreground">{bySkill.map((skill) => `${skill.name} ${skill.n ? `${skill.ok}/${skill.n}` : "· not tested yet"}`).join(" · ")}</small>
        ) : null}
      </div>
      {soundsLikeYou ? (
        <div className="rounded-xl bg-success-subtle px-3 py-2.5 text-sm"><b>Your twin sounds like you.</b> Your learners get these answers.</div>
      ) : needsMaterial ? (
        <div className="rounded-xl bg-caution-subtle px-3 py-2.5 text-sm">
          <b>Your twin needs more of your material here.</b>{" "}
          <Link href="/twin/knowledge" className="font-semibold text-brand-strong underline-offset-2 hover:underline">Add files in Knowledge &amp; files</Link>
        </div>
      ) : null}

      {/* Earlier cards: finished ones leave the stage, so each card starts on a clean screen (the twin starts fresh too). */}
      {done.length ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={showEarlier}
            onClick={() => setShowEarlier((open) => !open)}
            className="flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground underline-offset-2 hover:underline"
          >
            <ChevronRight className={cn("size-4 transition-transform", showEarlier && "rotate-90")} aria-hidden />
            Earlier cards ({done.length})
          </button>
          {showEarlier ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {done.map((card) => {
                const liked = card.turns[0]?.rating === "like";
                const open = openEarlier === card.key;
                return (
                  <li key={card.key} className="rounded-lg border">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenEarlier(open ? null : card.key)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                    >
                      <span aria-hidden className={liked ? "text-success" : "text-caution"}>{liked ? "✓" : "•"}</span>
                      <span className="min-w-0 flex-1 truncate">{stripAttachments(card.turns[0].learner).text}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{card.skill} · {liked ? "Felt like you" : "Felt off"}</span>
                    </button>
                    {open ? <div className="flex flex-col gap-2 border-t px-3 py-3">{cardBody(card)}</div> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Stage: only the card in progress (question and answer), the question in brand orange. */}
      <div ref={chatRef} className="flex max-h-[min(460px,52dvh)] flex-col gap-2 overflow-y-auto p-0.5">
        {current ? (
          cardBody(current)
        ) : starting || packComplete || done.length ? (
          <p className="m-0 text-sm text-muted-foreground">
            {starting ? "Getting your twin ready…" : packComplete ? "Pack complete: every answer is marked." : "Card done."}
          </p>
        ) : null}
      </div>

      {/* Under the stage: the step line while a card is in progress; otherwise the next question, or a new pack. */}
      {current ? (
        <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {stepLine(current).busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {stepLine(current).text}
        </p>
      ) : packComplete ? (
        // Only the next pack here: the results are behind Finish at the top, as at any point.
        <div className="flex gap-2">
          <Button size="sm" variant="strong" disabled={starting} onClick={() => void start()}>Start a new pack</Button>
        </div>
      ) : next ? (
        // The prototype's suggestion above the reply box: tap to ask it; the clip to send a file with it (as on a call);
        // "Ask your own instead" to ask her own in its place (the suggested one goes back to the pool). Both open the
        // same composer as "What feels off?".
        <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-2.5">
          <small className="px-1 text-xs text-muted-foreground">{draft?.cardId === next.id && draft.own ? "Your own question" : next.skill}</small>
          {attach ? (
            <input
              ref={fileInput}
              type="file"
              accept={DURING_UPLOAD_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void attachFile(next, file);
              }}
            />
          ) : null}
          {draft?.cardId === next.id ? (
            <Composer
              text={draft.text}
              files={draft.files ?? []}
              onChange={({ text, files }) => setDraft((current) => (current ? { ...current, text, files } : current))}
              placeholder="Ask your own question as a learner would…"
              label={draft.own ? "Your own question" : "The question"}
              calibrationId={calibrationId!}
              attach={attach && sessionId ? { sessionId, onKnown: (file) => setAttached((map) => new Map(map).set(file.id, file)) } : undefined}
              busy={busy}
              autoFocus
              listen={draft.listen}
              submitLabel="Ask"
              canSubmit={Boolean(draft.text.trim() || draft.files?.length) && Boolean(calibrationId)}
              onCancel={() => setDraft(null)}
              onSubmit={() => {
                const text = draft.text.trim();
                const files = draft.files ?? [];
                setDraft(null);
                // Anything but the suggested question as written is hers: it takes the card's place.
                void ask({ card: next, text, source: !draft.own && text === next.question ? "suggested" : "own", files });
              }}
            />
          ) : (
            <>
              <button
                type="button"
                disabled={busy || !calibrationId}
                onClick={() => void ask({ card: next, text: next.question, source: "suggested" })}
                className="flex w-full items-start gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm transition-colors enabled:hover:border-brand enabled:hover:bg-brand/5 disabled:cursor-default disabled:opacity-50"
              >
                <span aria-hidden className="flex-none text-muted-foreground">↗</span>
                {next.question}
              </button>
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                {attach ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Attach a file to this question"
                    title={`Attach a file. ${DURING_UPLOAD_RULE}`}
                    disabled={busy || uploading || !calibrationId}
                    onClick={() => fileInput.current?.click()}
                  >
                    {uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
                  </Button>
                ) : null}
                <span className="flex-1" />
                <button
                  type="button"
                  disabled={busy || !calibrationId}
                  onClick={() => setDraft({ cardId: next.id, text: "", own: true })}
                  className="px-1 underline-offset-2 enabled:hover:underline disabled:opacity-50"
                >
                  Ask your own instead
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {whyFor ? <WhyPanel key={whyFor.id} turn={whyFor.evidence} onClose={() => setWhyFor(null)} /> : null}
    </PageContainer>
  );
}

/**
 * "What was off?": one tap per thing that was wrong (the advice, the facts, how it's said, out of scope), then what she would say instead in the composer (a file, or spoken:
 * the recording is kept), then Save.
 */
function OffBox({ draft, calibrationId, busy, onChange, onCancel, onSave, attach }: {
  draft: OffDraft;
  calibrationId: string;
  busy: boolean;
  onChange: (draft: OffDraft) => void;
  onCancel: () => void;
  onSave: (draft: OffDraft) => void;
  attach?: { sessionId: string; onKnown: (file: Attachment) => void };
}) {
  // The latest draft for the composer's late results (a transcript, an upload): reasons ticked meanwhile are kept.
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  // Each change builds on the one before it at once: a recording lands as its words and then its audio, back to back,
  // before a re-render could refresh `latest` (built from the stale draft, the audio would wipe the words).
  const update = (patch: Partial<OffDraft>) => {
    latest.current = { ...latest.current, ...patch };
    onChange(latest.current);
  };
  const toggle = (reason: string) => {
    const reasons = latest.current.reasons;
    update({ reasons: reasons.includes(reason) ? reasons.filter((r) => r !== reason) : [...reasons, reason] });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border px-3 py-2.5">
      <p className="m-0 text-sm font-semibold">What was off?</p>
      <div className="flex flex-wrap gap-1.5">
        {OFF_REASONS.map((reason) => {
          const picked = draft.reasons.includes(reason.code);
          return (
            <button
              key={reason.code}
              type="button"
              aria-pressed={picked}
              onClick={() => toggle(reason.code)}
              className={cn("rounded-full border px-3 py-1 text-sm", picked ? "border-brand bg-brand/10 font-semibold" : "bg-card")}
            >
              {reason.label}
            </button>
          );
        })}
      </div>
      <Composer
        text={draft.text}
        files={draft.files}
        onChange={({ text, files }) => update({ text, files })}
        onSpoken={(audioKey) => update({ audioKey: audioKey ?? latest.current.audioKey, input: "voice" })}
        placeholder="What would you say instead? Say it as you'd say it to the learner."
        label="What would you say instead?"
        calibrationId={calibrationId}
        attach={attach}
        busy={busy}
        submitLabel="Save"
        canSubmit={draft.reasons.length > 0}
        onCancel={onCancel}
        onSubmit={() => onSave(latest.current)}
      />
    </div>
  );
}

/**
 * The composer both boxes use, like other AI tools': her words and files, then 📎 (attach, as on a call) and 🎤
 * (speak: transcribed by /api/calibration-audio, the recording kept, the words added to the box to read and edit)
 * along the bottom edge, with Cancel and the submit button.
 */
function Composer({ text, files, onChange, onSpoken, placeholder, label, calibrationId, attach, busy, autoFocus, listen, submitLabel, canSubmit, onCancel, onSubmit }: {
  text: string;
  files: Attachment[];
  onChange: (next: { text: string; files: Attachment[] }) => void;
  /** Her answer was spoken: the recording's key (null when it couldn't be kept). */
  onSpoken?: (audioKey: string | null) => void;
  placeholder: string;
  label: string;
  calibrationId: string;
  attach?: { sessionId: string; onKnown: (file: Attachment) => void };
  busy: boolean;
  autoFocus?: boolean;
  /** Opened from a mic: start listening straight away. */
  listen?: boolean;
  submitLabel: string;
  canSubmit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The latest words, files and callbacks, for results that land later (typing meanwhile isn't lost).
  const latest = useRef({ text, files, onChange, onSpoken });
  useEffect(() => {
    latest.current = { text, files, onChange, onSpoken };
  }, [text, files, onChange, onSpoken]);

  const addFile = async (file: File) => {
    if (!attach) return;
    setUploading(true);
    try {
      const attachment = await uploadToSession(attach.sessionId, file);
      attach.onKnown(attachment);
      latest.current.onChange({ text: latest.current.text, files: [...latest.current.files, attachment] });
    } catch (error) {
      toast.error(message(error));
    } finally {
      setUploading(false);
    }
  };

  const record = async () => {
    if (recording) return recorderRef.current?.stop();
    try {
      stopPlayback(); // the twin stops talking while she speaks
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        setTranscribing(true);
        try {
          const form = new FormData();
          form.set("calibrationId", calibrationId);
          form.set("audio", new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
          const response = await fetch("/api/calibration-audio", { method: "POST", body: form });
          const body = (await response.json().catch(() => ({}))) as { text?: string; audioKey?: string | null; error?: string };
          if (!response.ok) throw new Error(body.error ?? "Couldn't turn that into text. Try again, or type it.");
          const now = latest.current;
          now.onChange({ text: [now.text.trim(), body.text ?? ""].filter(Boolean).join(" "), files: now.files });
          now.onSpoken?.(body.audioKey ?? null);
        } catch (error) {
          toast.error(message(error));
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      toast.error("Allow the microphone to speak, or type it.");
    }
  };

  const working = busy || recording || transcribing || uploading;

  // Opened from the question's mic: listening starts at once (the browser asks for the microphone the first time).
  const listened = useRef(false);
  useEffect(() => {
    if (!listen || listened.current) return;
    listened.current = true;
    void record();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when opened to listen
  }, [listen]);

  return (
    <form
      className="flex flex-col gap-1 rounded-xl border bg-background px-3 pt-2 pb-1.5 focus-within:ring-3 focus-within:ring-ring/50"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !working) onSubmit();
      }}
    >
      {files.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-1 rounded-full border bg-card py-0.5 pr-1 pl-2.5 text-xs">
              <span className="max-w-[180px] truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                className="rounded-full p-0.5 hover:bg-muted"
                onClick={() => onChange({ text, files: files.filter((other) => other.id !== file.id) })}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        rows={2}
        autoFocus={autoFocus}
        value={text}
        onChange={(event) => onChange({ text: event.target.value, files })}
        placeholder={recording ? "Listening… tap the mic again to stop." : placeholder}
        aria-label={label}
        className="min-h-12 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-1">
        {attach ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={DURING_UPLOAD_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void addFile(file);
              }}
            />
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Attach a file" title={`Attach a file. ${DURING_UPLOAD_RULE}`} disabled={working} onClick={() => fileInput.current?.click()}>
              {uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant={recording ? "destructive" : "ghost"}
          aria-label={recording ? "Stop recording" : "Speak"}
          aria-pressed={recording}
          title={recording ? "Stop recording" : "Speak"}
          disabled={busy || transcribing || uploading}
          onClick={() => void record()}
        >
          {recording ? <Square className="animate-pulse" /> : transcribing ? <LoaderCircle className="animate-spin" /> : <Mic />}
        </Button>
        {transcribing ? <span className="text-xs text-muted-foreground">Writing it down…</span> : null}
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" disabled={busy || recording} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" variant="strong" disabled={working || !canSubmit}>
          <ArrowUp className="size-3.5" />
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

type TwinScore = { packsDone: number; target: number; reliable: boolean; accuracy: number | null };

/**
 * The coach's packs toward a reliable score, top left of Calibrate: a ring filling one part per completed pack (a
 * fixed number, decided in advance), then her accuracy once they're done. ⓘ explains why, in plain words; the
 * statistics themselves stay in the backend.
 */
function ScoreRing({ score }: { score: TwinScore }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(score.packsDone, score.target) / score.target;
  return (
    <div className="flex items-center gap-3">
      <span className="relative inline-flex size-11 shrink-0 items-center justify-center" aria-hidden>
        <svg viewBox="0 0 36 36" className="absolute inset-0 size-11 -rotate-90">
          <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="3.5" className="stroke-muted" />
          <circle
            cx="18" cy="18" r={radius} fill="none" strokeWidth="3.5" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={circumference * (1 - filled)}
            className={cn("transition-all", score.reliable ? "stroke-success" : "stroke-brand")}
          />
        </svg>
        <span className="text-xs font-semibold tabular-nums">{score.reliable ? "✓" : `${score.packsDone}/${score.target}`}</span>
      </span>
      <p className="m-0 text-sm">
        {score.reliable ? (
          <>
            <b>Your accuracy score{score.accuracy !== null ? `: ${score.accuracy}%` : ""}</b>
            <span className="text-muted-foreground"> · updates with every pack</span>
          </>
        ) : (
          <>
            <b>{score.packsDone} of {score.target} packs complete</b>
            <span className="text-muted-foreground"> · Your accuracy score unlocks at {score.target}</span>
          </>
        )}
      </p>
      <Popover>
        <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Why 6 packs" />}>
          <Info />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <p className="m-0 font-semibold">Why {score.target} packs?</p>
          {/* Info popover copy: title + 1–3 sentences, to "you" (no "we"), as the rest of the studio's copy. */}
          <p className="m-0 mt-1 text-muted-foreground">
            Each pack is 10 learner questions, and with only a few answers your score can swing a lot. After every pack, your
            score is checked with the <b className="text-foreground">Wilson score interval</b>, a standard statistical method.
            After {score.target} packs, it&apos;s accurate to within about ±10 points (95% confidence).
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
