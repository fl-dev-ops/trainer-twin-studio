/**
 * The chat agent's two models, locked here (no env or per-request override):
 * - the speaking model writes every twin reply: Gemini on Vertex AI, through the Vercel AI Gateway (agent.ts);
 * - the decision model makes the small call before a turn (which playbook and situation, what to search for):
 *   Qwen on Cerebras, direct (lib/twin-query.ts).
 * Qwen also wrote the replies for a day (7 Nov 2026): fast, but it drifted from the playbooks and invented facts.
 */
export const SPEAKING_MODEL = "google/gemini-3.8-flash";
/** AI Gateway route for the speaking model: Vertex AI only, never AI Studio. */
export const SPEAKING_ROUTE = "vertex";
export const DECISION_MODEL = "cerebras/qwen-3.8-27b";
