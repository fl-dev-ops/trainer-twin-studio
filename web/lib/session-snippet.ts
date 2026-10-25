type Turn = { role?: string; text?: string };

/** The learner's first message and the reply to it: what a session was about, for list previews. */
export function firstExchange(transcript: unknown): { ask: string | null; reply: string | null } {
  const turns = (Array.isArray(transcript) ? transcript : []) as Turn[];
  const clean = (text?: string) => text?.replace(/\s+/g, " ").trim() || null;
  const askAt = turns.findIndex((t) => t.role === "user" && clean(t.text));
  if (askAt === -1) return { ask: null, reply: clean(turns.find((t) => t.role === "trainer")?.text) };
  const reply = turns.slice(askAt + 1).find((t) => t.role === "trainer" && clean(t.text));
  return { ask: clean(turns[askAt].text), reply: clean(reply?.text) };
}
