/**
 * Per-session cache of the trainer's real phrasing for the few recurring moments of a resume round.
 * A style lookup takes 1.5–3.7 s (embedding + vector search) and returns 2–5k tokens, so it is
 * fetched once per session inside a call that runs while the trainer is already speaking, then
 * compacted (~300 chars per example) into each turn's plan block. Turns never wait for it.
 */
export const STYLE_SITUATIONS = {
  follow_up: "learner gave a partial or vague answer about their own project; acknowledge briefly and probe one specific gap with a targeted follow-up",
  dont_know: "learner says they don't know or can't remember; reassure briefly and re-ask from an easier angle or a trade-off",
  next_question: "learner finished discussing one project; acknowledge briefly and move on to the next project on their resume",
  closing: "end of the interview: give brief evidence-grounded feedback, one strength and one thing to improve, then ask if they are ready to end the session",
} as const;

export type StyleSituation = keyof typeof STYLE_SITUATIONS;
export type StyleCache = Partial<Record<StyleSituation, string[]>>;

const EXAMPLES_PER_SITUATION = 2;
const EXAMPLE_CHARS = 300;
const KEPT_FIELDS = ["Speech function", "Phrasing features", "Cadence", "Topic-neutral pattern", "Sentence shape"];

/** Keeps how the trainer speaks (function, features, cadence, pattern) and drops headers and past-session detail. */
export function compactStyleExample(text: string): string {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z -]+):\s*(.+)$/);
    if (match && KEPT_FIELDS.includes(match[1])) fields.set(match[1], match[2].trim());
  }
  const pattern = fields.get("Topic-neutral pattern") ?? fields.get("Sentence shape") ?? "";
  const parts = [
    fields.get("Speech function") && `does: ${fields.get("Speech function")}`,
    fields.get("Cadence") && `cadence: ${fields.get("Cadence")}`,
    pattern && `sounds like: "${pattern.slice(0, EXAMPLE_CHARS)}"`,
  ].filter(Boolean);
  return parts.join("; ");
}

type Fetch = <T>(payload: Record<string, unknown>) => Promise<T>;
type StyleResponse = { phrasingStyle?: { text?: string }[] };

export async function fetchStyleCache(personaSlug: string, fetch: Fetch): Promise<StyleCache> {
  const entries = await Promise.all((Object.keys(STYLE_SITUATIONS) as StyleSituation[]).map(async (situation) => {
    const result = await fetch<StyleResponse>({
      action: "searchStyleEpisodes",
      personaSlug,
      query: STYLE_SITUATIONS[situation],
      sessionPhase: "middle",
      limit: EXAMPLES_PER_SITUATION,
    }).catch(() => null);
    const examples = (result?.phrasingStyle ?? [])
      .map((hit) => compactStyleExample(hit.text ?? ""))
      .filter(Boolean)
      .slice(0, EXAMPLES_PER_SITUATION);
    return [situation, examples] as const;
  }));
  return Object.fromEntries(entries.filter(([, examples]) => examples.length));
}
