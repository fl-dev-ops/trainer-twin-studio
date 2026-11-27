import { describe, expect, test } from "bun:test";
import { learnerName, nameOnly, reportFields, sessionDetail, sessionSummary, transcriptTurns, UNNAMED_LEARNER } from "@/lib/copilot-reads";

/**
 * The copilot's privacy contract (lib/copilot-reads.ts): rows stuffed with canaries in every field it must never send
 * on, as a database row might carry them, and the answers checked for each canary anywhere in their JSON.
 */

const CANARIES = {
  email: "canary.learner@private.example",
  share: "SHARECODE-canary-1f2e",
  token: "runtime-token-hash-canary",
  activation: "activation-key-canary",
  ip: "ip-hash-canary-9a8b",
  origin: "https://canary-customer.example",
  audio: "s3://canary-bucket/audio/session.ogg",
  audioUrl: "https://canary.s3.amazonaws.com/signed?X-Amz-Signature=canary",
  video: "video-egress-canary",
  room: "livekit-room-canary",
  cv: "Priya_Canary_CV_2026.pdf",
  snapshot: "compiled-snapshot-canary",
  runtime: "runtime-state-canary",
};

function leaks(value: unknown) {
  const json = JSON.stringify(value);
  return Object.entries(CANARIES).filter(([, canary]) => json.includes(canary)).map(([name]) => name);
}

const report = {
  summary: "Handled the price objection well.",
  summaryTags: ["Objections", "Rapport"],
  focusNextTime: "Ask for the close sooner.",
  score: 72,
  generatedAt: "2026-11-20T10:00:00.000Z",
  keyMoments: [{ id: "km1", number: "1", at: 12, timestamp: "0:12", seconds: 12, title: "Pushback", quote: "That's too expensive.", description: "Reframed on value.", audioUrl: CANARIES.audioUrl }],
  rubricScores: [{ criterion: "Discovery", points: 3, maxPoints: 5, reason: "Asked two questions." }],
  goalResults: [{ goal: "Book a call", status: "partly" as const, evidence: "Agreed to talk next week." }],
};

/** A session as Prisma might hand it over if a select ever widened: every sensitive column filled with a canary. */
const row = {
  id: "sess_1",
  status: "completed",
  mode: "voice",
  createdAt: new Date("2026-11-20T09:59:00Z"),
  startedAt: new Date("2026-11-20T10:00:00Z"),
  endedAt: new Date("2026-11-20T10:04:30Z"),
  reportStatus: "completed",
  report,
  feedbackRating: 4,
  feedbackNote: "Useful practice.",
  anonymousName: null,
  user: { name: "Priya Shah", email: CANARIES.email },
  agent: { name: "Renewal call", slug: "renewal-call", kind: "ROLEPLAY" },
  transcript: [
    { role: "assistant", text: "Hi, thanks for joining.", audioUrl: CANARIES.audioUrl, at: 1 },
    { role: "user", text: "Happy to be here.", attachment: { name: CANARIES.cv } },
    { role: "user", text: "   " },
  ],
  s3AudioKey: CANARIES.audio,
  audioEgressId: null,
  videoEgressId: CANARIES.video,
  // Columns no select includes today: here to prove the mappers don't pass rows through.
  shareCode: CANARIES.share,
  runtimeTokenHash: CANARIES.token,
  activationKey: CANARIES.activation,
  anonymousIpHash: CANARIES.ip,
  embedOrigin: CANARIES.origin,
  livekitRoom: CANARIES.room,
  contextName: CANARIES.cv,
  compiledSnapshot: { canary: CANARIES.snapshot },
  runtimeState: { canary: CANARIES.runtime },
};

describe("copilot reads: what leaves the studio", () => {
  test("a session summary carries no canary and exactly its listed fields", () => {
    const summary = sessionSummary(row as never);
    expect(leaks(summary)).toEqual([]);
    expect(Object.keys(summary).sort()).toEqual(
      ["agent", "id", "kind", "learner", "learnerRating", "minutes", "mode", "report", "score", "startedAt", "status", "tags"].sort(),
    );
    expect(summary).toMatchObject({ learner: "Priya Shah", kind: "roleplay", minutes: 4.5, report: "ready", score: 72 });
  });

  test("a session in full: the transcript and report, but no recording link, file, code or email", () => {
    const detail = sessionDetail(row as never);
    expect(leaks(detail)).toEqual([]);
    expect(detail.hasRecording).toBe(true);
    expect(detail.transcript.turns).toEqual([
      { n: 1, speaker: "role play", text: "Hi, thanks for joining." },
      { n: 2, speaker: "learner", text: "Happy to be here." },
    ]);
    expect(Object.keys(detail.report!.keyMoments[0]).sort()).toEqual(["description", "number", "quote", "title"]);
    expect(detail.learnerFeedback).toBe("Useful practice.");
  });

  test("the report keeps its content and drops the recording link", () => {
    const fields = reportFields(report);
    expect(leaks(fields)).toEqual([]);
    expect(fields.goals?.[0]).toEqual({ goal: "Book a call", status: "partly", evidence: "Agreed to talk next week." });
  });

  test("transcripts page by turns, so long sessions are read in parts", () => {
    const long = Array.from({ length: 130 }, (_, index) => ({ role: index % 2 ? "user" : "assistant", text: `turn ${index + 1}` }));
    const first = sessionDetail({ ...row, transcript: long } as never);
    expect(first.transcript).toMatchObject({ totalTurns: 130, fromTurn: 1, nextFromTurn: 61 });
    expect(first.transcript.turns).toHaveLength(60);
    const last = sessionDetail({ ...row, transcript: long } as never, 121);
    expect(last.transcript.turns.map((turn) => turn.n)).toEqual(Array.from({ length: 10 }, (_, i) => 121 + i));
    expect("nextFromTurn" in last.transcript).toBe(false);
  });

  test("learners are named, never shown by email, and nameless ones are 'Unnamed learner'", () => {
    expect(learnerName({ name: "Priya Shah" }, null)).toBe("Priya Shah");
    expect(learnerName({ name: CANARIES.email }, null)).toBe(UNNAMED_LEARNER);
    expect(learnerName({ name: "" }, "Surya (website)")).toBe("Surya (website)");
    expect(learnerName(null, null)).toBe(UNNAMED_LEARNER);
    expect(learnerName(null, "me at canary@x.io")).toBe(UNNAMED_LEARNER);
    expect(nameOnly("  Asha   Rao ")).toBe("Asha Rao");
    const anonymous = sessionSummary({ ...row, user: null, anonymousName: CANARIES.email } as never);
    expect(anonymous.learner).toBe(UNNAMED_LEARNER);
    expect(leaks(anonymous)).toEqual([]);
  });

  test("turns keep only who spoke and what was said", () => {
    expect(transcriptTurns([{ role: "user", text: "Hi", at: 3, audioUrl: CANARIES.audioUrl, id: "t1" }, "junk", null], "twin"))
      .toEqual([{ speaker: "learner", text: "Hi" }]);
  });
});
