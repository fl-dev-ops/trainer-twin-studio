import { expect, test } from "bun:test";
import { numberedTranscript, placeKeyMoments, recordingStartOf, type ReportTurn } from "@/lib/session-report";

// Key-moment times come from the transcript's own timing, never from the model: it only names the turn it quotes.

const start = Date.parse("2026-11-02T08:49:41.000Z");
const turns: ReportTurn[] = [
  { speaker: "Client", learner: false, text: "Hi, it's Sara, schools come first.", spokenAt: start + 2_000 },
  { speaker: "Learner", learner: true, text: "Hi Sara", spokenAt: start + 9_000 },
  { speaker: "Client", learner: false, text: "Where would you start?", spokenAt: start + 12_000 },
  { speaker: "Learner", learner: true, text: "do u have any requirements..??", spokenAt: start + 95_400 },
  { speaker: "Learner", learner: true, text: "whats ur budget..", spokenAt: start + 201_000 },
];

test("the model sees numbered turns", () => {
  expect(numberedTranscript(turns.slice(0, 2))).toBe("[1] Client: Hi, it's Sara, schools come first.\n\n[2] Learner: Hi Sara");
});

test("a moment takes its cited turn's time, measured from the recording start", () => {
  const [moment] = placeKeyMoments("s1", [{ number: "01", turn: 4, title: "Abrupt", quote: "Do you have any requirements?", description: "d" }], turns, start);
  expect(moment).toMatchObject({ id: "s1-m1", number: "01", at: 95, seconds: 95, timestamp: "1:35" });
});

test("a cited turn that doesn't hold the quote falls back to the learner turn that does", () => {
  const [moment] = placeKeyMoments("s1", [{ number: "01", turn: 2, title: "Budget", quote: "whats ur budget", description: "d" }], turns, start);
  expect(moment.at).toBe(201);
  expect(moment.timestamp).toBe("3:21");
});

test("no matching turn, no timing or no recording start: no time at all, rather than a guess", () => {
  const unknown = placeKeyMoments("s1", [{ number: "01", turn: 99, title: "t", quote: "never said this", description: "d" }], turns, start);
  expect(unknown[0].at).toBeUndefined();
  expect(unknown[0].timestamp).toBeUndefined();
  const untimed = turns.map((turn) => ({ ...turn, spokenAt: undefined }));
  expect(placeKeyMoments("s1", [{ turn: 4, quote: "do u have any requirements", title: "t", description: "d" }], untimed, start)[0].at).toBeUndefined();
  expect(placeKeyMoments("s1", [{ turn: 4, quote: "do u have any requirements", title: "t", description: "d" }], turns, null)[0].at).toBeUndefined();
  // A model that still sends a guessed time doesn't get it through.
  expect(placeKeyMoments("s1", [{ turn: 99, quote: "x", timestamp: "0:20", seconds: 20, title: "t", description: "d" }], turns, start)[0]).not.toHaveProperty("seconds");
});

test("at most 3 moments; the recording's first frame wins over the session start", () => {
  const four = [1, 2, 3, 4].map((n) => ({ number: `0${n}`, turn: 4, title: "t", quote: "requirements", description: "d" }));
  expect(placeKeyMoments("s1", four, turns, start)).toHaveLength(3);
  const sessionStart = new Date(start - 5_000);
  expect(recordingStartOf({ recordingStartedAt: start }, sessionStart)).toBe(start);
  expect(recordingStartOf({}, sessionStart)).toBe(start - 5_000);
  expect(recordingStartOf(null, null)).toBeNull();
});
