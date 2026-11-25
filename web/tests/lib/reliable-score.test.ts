import { expect, test } from "bun:test";
import { RELIABLE_PACKS, wilson } from "@/lib/twin/reliable-score";

const round = (interval: { low: number; high: number } | null) => interval && [+interval.low.toFixed(4), +interval.high.toFixed(4)];

test("Wilson matches the published examples (Newcombe 1998, Statistics in Medicine 17:857)", () => {
  expect(round(wilson(81, 263))).toEqual([0.2553, 0.3662]);
  expect(round(wilson(15, 148))).toEqual([0.0624, 0.1605]);
  expect(round(wilson(0, 20))).toEqual([0, 0.1611]);
  expect(round(wilson(1, 29))).toEqual([0.0061, 0.1718]);
});

test("the methodology's examples, and nothing outside 0–100%", () => {
  expect(round(wilson(24, 30))).toEqual([0.6269, 0.9049]); // 63% to 90%
  expect(round(wilson(48, 60))).toEqual([0.6822, 0.8817]); // 68% to 88%
  expect(wilson(10, 10)!.high).toBe(1);
  expect(wilson(0, 0)).toBeNull();
  expect(wilson(3, 2)).toBeNull();
  expect(RELIABLE_PACKS).toBe(6);
});
