// Jev (typesafe/jev-1.13): a typed decision model on OpenRouter's decisions API. It answers choice questions about a
// text `state` with calibrated probabilities (no prose), in well under a second. Same client as twin-memory's
// calibration-ui (src/lib/brain/jev.ts).

const JEV_MODEL = "typesafe/jev-1.13";
const BATCH = 20; // questions per request

export type JevQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer = { probabilities?: Record<string, number> };

async function request(state: string, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 || res.status === 408 || res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Jev ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
    return data.answers ?? {};
  }
  throw new Error("Jev unavailable");
}

/** Asks every question about one state, in parallel batches. Throws if any batch fails. */
export async function decide(state: string, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
  const entries = Object.entries(questions);
  const batches: [string, JevQuestion][][] = [];
  for (let i = 0; i < entries.length; i += BATCH) batches.push(entries.slice(i, i + BATCH));
  const parts = await Promise.all(batches.map((batch) => request(state, Object.fromEntries(batch))));
  return Object.assign({}, ...parts);
}

/** The most likely choice of an answer (null when Jev returned none). */
export function topChoice(answer: JevAnswer | undefined): string | null {
  const entries = Object.entries(answer?.probabilities ?? {});
  if (!entries.length) return null;
  return entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}
