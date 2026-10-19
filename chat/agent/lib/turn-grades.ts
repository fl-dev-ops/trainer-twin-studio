/**
 * Which answer grades lead to a follow-up this turn, published by the per-turn plan block
 * (instructions/plan-turn.ts) for the bridge (channels/openai-compat.ts). The bridge then refuses to
 * speak a session_plan `reply` whose grade actually leads to a new question — otherwise the trainer
 * says a follow-up AND the new question in one turn (seen 9:25 am, Oct 15).
 *
 * Lives on globalThis so both modules see it whatever way Eve bundles them. If they run in different
 * processes the bridge simply finds nothing and keeps today's behaviour.
 */
type TurnGrades = { followUpGrades: string[]; at: number };

const KEY = Symbol.for("trainertwin.turnGrades");
const store: Map<string, TurnGrades> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<string, TurnGrades>;
const MAX_AGE_MS = 10 * 60 * 1000;

/** null = no plan block this turn, so the bridge must not judge replies (keeps today's behaviour). */
export function publishTurnGrades(sessionId: string, followUpGrades: string[] | null) {
  if (followUpGrades === null) store.delete(sessionId);
  else store.set(sessionId, { followUpGrades, at: Date.now() });
  // ponytail: one entry per active session; drop stale ones so the Map can't grow unbounded.
  for (const [id, entry] of store) if (Date.now() - entry.at > MAX_AGE_MS) store.delete(id);
}

/** Follow-up grades for this session's current turn, or null when unknown (bridge keeps today's behaviour). */
export function followUpGradesFor(sessionId: string): string[] | null {
  const entry = store.get(sessionId);
  return entry && Date.now() - entry.at <= MAX_AGE_MS ? entry.followUpGrades : null;
}
