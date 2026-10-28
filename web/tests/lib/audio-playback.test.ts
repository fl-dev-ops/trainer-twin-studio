import { expect, test } from "bun:test";
import { splitPcm } from "@/lib/audio-playback";

test("PCM split at odd byte boundaries keeps every sample intact and returns the tail at the end", () => {
  const samples = Int16Array.from({ length: 1003 }, (_, i) => (i * 37) % 30000 - 15000);
  const bytes = new Uint8Array(samples.buffer);
  // Chunk sizes that often end mid-sample, as network reads do.
  const sizes = [1, 2, 7, 333, 64, 5, 999, 3];
  let carry: Uint8Array = new Uint8Array(0);
  const out: number[] = [];
  let at = 0;
  for (let i = 0; at < bytes.length; i++) {
    const end = Math.min(bytes.length, at + sizes[i % sizes.length]);
    const next = splitPcm(carry, bytes.subarray(at, end), 100);
    next.slices.forEach((slice) => out.push(...slice));
    carry = next.carry;
    at = end;
  }
  const last = splitPcm(carry, new Uint8Array(0), 100, true);
  last.slices.forEach((slice) => out.push(...slice));
  expect(last.carry.length).toBe(0);
  expect(out).toEqual([...samples]);
});
