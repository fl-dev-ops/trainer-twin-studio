/**
 * How far a twin's calibration score can be trusted (methodology: "Twin Calibration: Card Design and Reliable Scores").
 * The coach calibrates a fixed number of packs, decided in advance (no early finish, so the 95% holds as stated); the
 * accuracy is published once they are done, with a Wilson 95% interval kept in the backend, never shown to coaches.
 */

/** Packs (10 answers each) before a twin's score counts as reliable. */
export const RELIABLE_PACKS = 6;

const Z95 = 1.959964;

/**
 * Wilson score interval for k successes in n (Wilson 1927; recommended for small samples by Brown, Cai & DasGupta
 * 2001). Checked against the worked examples in Newcombe (1998). Null when nothing is marked.
 */
export function wilson(k: number, n: number, z = Z95): { low: number; high: number } | null {
  if (n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const divider = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / divider;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / divider;
  // All or none liked: the interval reaches exactly 1 (or 0); floating point would land a hair short.
  return { low: k === 0 ? 0 : Math.max(0, centre - half), high: k === n ? 1 : Math.min(1, centre + half) };
}
