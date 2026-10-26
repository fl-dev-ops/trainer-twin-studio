import { expect, test } from "bun:test";
import { durationSeconds, firstExchange, lastSevenDays, likeRateByWeek, titleFrom, transcriptTurns } from "@/lib/twin/stats";

test("transcripts become learner / twin turns; empty and malformed lines are dropped", () => {
  const turns = transcriptTurns([
    { role: "trainer", text: " Hi, what's going on? " },
    { role: "user", text: "My client went quiet." },
    { role: "trainer", text: "" },
    { speaker: "learner", text: "After the viewing." },
    "nonsense",
  ]);
  expect(turns).toEqual([
    { who: "twin", text: "Hi, what's going on?" },
    { who: "learner", text: "My client went quiet." },
    { who: "learner", text: "After the viewing." },
  ]);
  expect(transcriptTurns(null)).toEqual([]);
});

test("the first exchange skips the twin's greeting", () => {
  expect(firstExchange(transcriptTurns([
    { role: "trainer", text: "Hi." },
    { role: "user", text: "What do I say?" },
    { role: "trainer", text: "Ask what they want." },
  ]))).toEqual({ question: "What do I say?", answer: "Ask what they want." });
  expect(firstExchange([])).toEqual({ question: null, answer: null });
});

test("durations need both ends", () => {
  expect(durationSeconds(new Date(0), new Date(90_500))).toBe(91);
  expect(durationSeconds(new Date(0), null)).toBeNull();
  expect(durationSeconds(new Date(5000), new Date(1000))).toBeNull();
});

test("last 7 days: oldest first, today last, counted per UTC day", () => {
  const now = new Date("2026-10-27T12:00:00Z"); // a Tuesday
  const days = lastSevenDays([new Date("2026-10-27T01:00:00Z"), new Date("2026-10-27T23:00:00Z"), new Date("2026-10-21T10:00:00Z"), new Date("2026-10-20T10:00:00Z")], now);
  expect(days.map((d) => d.label)).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
  expect(days.map((d) => d.value)).toEqual([1, 0, 0, 0, 0, 0, 2]); // the 20th is 8 days back
});

test("feels-like-me rate per week, null for weeks with no ratings", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const rates = likeRateByWeek([
    { rating: "like", at: daysAgo(1) },
    { rating: "off", at: daysAgo(2) },
    { rating: "like", at: daysAgo(3) },
    { rating: "like", at: daysAgo(10) },
    { rating: "off", at: daysAgo(60) }, // older than 6 weeks
  ], 6, now);
  expect(rates).toEqual([null, null, null, null, 100, 67]);
});

test("titles come from the first line, shortened", () => {
  expect(titleFrom("  How   do I open? ", "Calibration")).toBe("How do I open?");
  expect(titleFrom(null, "Calibration")).toBe("Calibration");
  expect(titleFrom("x".repeat(100), "C")).toHaveLength(78);
});
