/** Matching a shown twin reply to its turn's evidence (client-safe: no server imports). */

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The turn whose reply contains this bubble. A live call shows a multi-sentence reply as several bubbles (one per
 * speech segment), so a bubble can be any part of the reply, not only its start; the latest matching turn wins.
 */
export function evidenceFor<T extends { reply: string }>(turns: T[], bubble: string): T | null {
  const said = norm(bubble);
  if (!said) return null;
  const head = (text: string) => text.slice(0, 40);
  for (let i = turns.length - 1; i >= 0; i--) {
    const reply = norm(turns[i].reply);
    if (reply && (reply.includes(head(said)) || said.includes(head(reply)))) return turns[i];
  }
  return null;
}
