import { expect, test } from "bun:test";
import { firstExchange } from "@/lib/session-snippet";
import { formatSessionTime } from "@/components/sessions/session-time";

test("preview is the learner's first message and the reply that follows it", () => {
  expect(firstExchange([
    { role: "trainer", text: "Hi! What would you like to practise?" },
    { role: "user", text: "  What do I say when a client asks\n about returns? " },
    { role: "trainer", text: "" },
    { role: "trainer", text: "Say it depends, then qualify." },
  ])).toEqual({ ask: "What do I say when a client asks about returns?", reply: "Say it depends, then qualify." });
});

test("falls back to the trainer opening when the learner never spoke", () => {
  expect(firstExchange([{ role: "trainer", text: "Hello there" }])).toEqual({ ask: null, reply: "Hello there" });
  expect(firstExchange(null)).toEqual({ ask: null, reply: null });
  expect(firstExchange([{ role: "user", text: "Only me" }])).toEqual({ ask: "Only me", reply: null });
});

test("session times read like the prototype", () => {
  const now = new Date(2026, 9, 26, 12, 0);
  expect(formatSessionTime(new Date(2026, 9, 26, 14, 14), now)).toMatch(/^Today, 2:14\s?pm$/);
  expect(formatSessionTime(new Date(2026, 9, 25, 11, 2), now)).toMatch(/^Yesterday, 11:02\s?am$/);
  expect(formatSessionTime(new Date(2026, 9, 21, 10, 5), now)).toMatch(/^Wed, 10:05\s?am$/);
  expect(formatSessionTime(new Date(2026, 8, 12, 15, 30), now)).toMatch(/^12 Sept?, 3:30\s?pm$|^Sep 12, 3:30\s?pm$/);
  expect(formatSessionTime(new Date(2025, 8, 12, 15, 30), now)).toContain("2025");
});
