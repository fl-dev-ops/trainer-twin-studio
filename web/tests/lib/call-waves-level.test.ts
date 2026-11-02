import { expect, test } from "bun:test";
import { MIC_NOISE_GATE, nextLevel } from "@/components/calibration/call-waves";

test("mic noise under the gate never lifts the wave", () => {
  let level = 0;
  for (let i = 0; i < 120; i++) level = nextLevel(level, MIC_NOISE_GATE * 0.9, MIC_NOISE_GATE);
  expect(level).toBe(0);
});

test("speech rises fast and falls slowly", () => {
  let level = 0;
  for (let i = 0; i < 5; i++) level = nextLevel(level, 0.3, MIC_NOISE_GATE);
  // 0.3 targets ~0.64 (gated, x2.5); 5 frames of attack cover most of it.
  expect(level).toBeGreaterThan(0.45);
  const peak = level;
  for (let i = 0; i < 5; i++) level = nextLevel(level, 0, MIC_NOISE_GATE);
  expect(level).toBeGreaterThan(peak * 0.6);
  expect(level).toBeLessThanOrEqual(1);
});
