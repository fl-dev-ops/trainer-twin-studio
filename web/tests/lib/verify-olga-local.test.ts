import { expect, test } from "bun:test";
import { assertVerificationCounts, sourceTimestamp } from "../../scripts/verify-olga-local";

const expected = {
  agents: 12, roleplays: 9, twins: 3, skillSources: 52, specVersions: 23, mappedVersions: 16,
  currentTwinItems: [70, 77], historicalVersions: [1, 2, 3, 4],
};

test("accepts exact restored Olga inventory without depending on ordering", () => {
  expect(() => assertVerificationCounts(expected)).not.toThrow();
  expect(() => assertVerificationCounts({ ...expected, currentTwinItems: [77, 70], historicalVersions: [4, 2, 1, 3] })).not.toThrow();
});

test.each(["agents", "roleplays", "twins", "skillSources", "specVersions", "mappedVersions"] as const)("refuses changed %s", (key) => {
  expect(() => assertVerificationCounts({ ...expected, [key]: expected[key] + 1 })).toThrow("inventory");
});

test("refuses changed current examples or concealed history gaps", () => {
  expect(() => assertVerificationCounts({ ...expected, currentTwinItems: [70, 76] })).toThrow();
  expect(() => assertVerificationCounts({ ...expected, historicalVersions: [] })).toThrow();
  expect(() => assertVerificationCounts({ ...expected, historicalVersions: [1, 2, 3, 4, 5] })).toThrow();
});

test("compares timestamp-without-time-zone audit values to Prisma UTC dates independently of host timezone", () => {
  expect(sourceTimestamp("2026-11-05T22:59:41.889")).toBe(sourceTimestamp(new Date("2026-11-05T22:59:41.889Z")));
  expect(sourceTimestamp("2026-11-07T09:17:05.09")).toBe("2026-11-07T09:17:05.090Z");
  expect(sourceTimestamp("2026-11-07T09:17:05.090Z")).toBe("2026-11-07T09:17:05.090Z");
  expect(() => sourceTimestamp("invalid")).toThrow();
});
