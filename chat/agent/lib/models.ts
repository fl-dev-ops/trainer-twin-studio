/**
 * The chat agent's two models (no per-request override):
 * - the speaking model writes every twin reply: Gemini on Vertex AI by default, through the Vercel AI Gateway
 *   (agent.ts); EXP_SPEAKING_MODEL / EXP_SPEAKING_ROUTE switch it (below);
 * - the decision model makes the small call before a turn (which playbook and situation, what to search for):
 *   Qwen on Cerebras, direct (lib/twin-query.ts).
 * Qwen also wrote the replies for a day (7 Nov 2026): fast, but it drifted from the playbooks and invented facts.
 */
export const SPEAKING_MODEL = process.env.EXP_SPEAKING_MODEL?.trim() || "google/gemini-3.8-flash";
/** AI Gateway route for the speaking model: Vertex AI only, never AI Studio. */
export const SPEAKING_ROUTE = process.env.EXP_SPEAKING_ROUTE?.trim() || "vertex";
// EXP_SPEAKING_MODEL / EXP_SPEAKING_ROUTE: switch the speaking model without a code change, e.g.
// deepseek/deepseek-v4.1-flash-1017 on parasail (10 Nov 2026: whole learner turn ~2.8 s p50 vs ~5.0 s on Gemini, similar
// answer quality). Unset = Gemini on Vertex. A non-Google model must be pinned to a provider (the gateway's default
// routing can land on a slow or dead host); agent.ts turns its reasoning off and compose-instructions.ts adds
// prompts/speaking-reminder.md.
export const DECISION_MODEL = "cerebras/qwen-3.8-27b";
