import { describe, expect, test } from "bun:test";
import { rawScore, scoreFrom, scoreQuestions } from "@/lib/twin/calibration-score";
import { accuracyOf } from "@/lib/twin/stats";

const call = [
  { who: "learner" as const, text: "Can you hear me?" }, // 0 noise
  { who: "twin" as const, text: "Yes, loud and clear." }, // 1
  { who: "learner" as const, text: "My buyer wants to wait for prices to drop." }, // 2
  { who: "twin" as const, text: "Tell them prices only go up.", rating: "off" as const }, // 3 meant
  { who: "learner" as const, text: "Feels off" }, // 4 the button's message
  { who: "twin" as const, text: "What felt off?" }, // 5
  { who: "learner" as const, text: "I'd never promise prices, I ask what they're waiting for." }, // 6 feedback
  { who: "twin" as const, text: "Got it." }, // 7
  { who: "learner" as const, text: "And if they say the developer might go bust?" }, // 8
  { who: "twin" as const, text: "Ask what would make them feel safe.", rating: "off" as const }, // 9 mis-click
  { who: "learner" as const, text: "Oops, that was fine, keep going." }, // 10 feedback
];
const choose = (choice: string) => ({ probabilities: { [choice]: 0.9, other: 0.1 } });

describe("calibration score", () => {
  test("asks about each trainer line (not the Feels off button's) and each Feels off reply", () => {
    expect(Object.keys(scoreQuestions(call)).sort()).toEqual(["off-3", "off-9", "turn-0", "turn-10", "turn-2", "turn-6", "turn-8"].sort());
  });

  test("counts conversation turns and meant Feels off only", () => {
    const answers = {
      "turn-0": choose("noise"),
      "turn-2": choose("conversation"),
      "turn-6": choose("feedback"),
      "turn-8": choose("conversation"),
      "turn-10": choose("feedback"),
      "off-3": choose("meant"),
      "off-9": choose("mistake"),
    };
    const score = scoreFrom(call, answers);
    expect(score).toEqual({ turns: 2, off: 1 });
    expect(accuracyOf(score)).toBe(50);
  });

  test("unanswered questions count as turns and as meant", () => {
    expect(scoreFrom(call, {})).toEqual({ turns: 5, off: 2 });
  });

  test("raw counts and accuracy edges", () => {
    expect(rawScore(call)).toEqual({ turns: 5, off: 2 });
    expect(accuracyOf({ turns: 0, off: 0 })).toBeNull();
    expect(accuracyOf({ turns: 2, off: 5 })).toBe(0);
  });
});
