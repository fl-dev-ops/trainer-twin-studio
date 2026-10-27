import { expect, test } from "bun:test";
import { parseMinutes, stepMinutes } from "@/components/duration-input";

test("minutes parse only as whole numbers in 1..10000", () => {
  expect(parseMinutes("30")).toBe(30);
  for (const bad of ["", " ", "0", "-5", "2.5", "abc", "10001"]) expect(parseMinutes(bad)).toBeNull();
});

test("− / + land on multiples of the step and stay in range", () => {
  expect(stepMinutes(30, 5)).toBe(35);
  expect(stepMinutes(28, 5)).toBe(30);
  expect(stepMinutes(28, -5)).toBe(25);
  expect(stepMinutes(30, -5)).toBe(25);
  expect(stepMinutes(5, -5)).toBe(1);
  expect(stepMinutes(1, -5)).toBe(1);
  expect(stepMinutes(9_998, 5)).toBe(10_000);
  expect(stepMinutes(null, 5)).toBe(5);
  expect(stepMinutes(null, -5)).toBe(1);
});
