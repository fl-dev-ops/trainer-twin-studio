/**
 * What kind of session this is, decided once:
 *
 *   twin                the trainer's twin advises a learner on a real situation (all-skills or one skill twin)
 *   twin-calibration    the same twin while its trainer tests it; only the "Feels off" feedback differs
 *   roleplay-client     a role play (builder client, recording-authored or ported interview): its published skill
 *   unavailable         nothing to run (an agent that is neither a role play nor a twin): the session says so and ends
 *
 * The prompt layers (lib/compose-instructions.ts), the runtime event texts (below) and the role-play tool guard
 * (lib/session-mode-lookup.ts) all follow from this one answer.
 */
export type SessionMode = "twin" | "twin-calibration" | "roleplay-client" | "unavailable";

/** The agent facts that decide the mode; SessionSpecs has them, and so does a raw agent once classified. */
export type ModeFacts = { roleplay?: unknown; twin?: unknown; calibration?: boolean };

export function sessionMode(facts: ModeFacts): SessionMode {
  if (facts.roleplay) return "roleplay-client";
  if (facts.twin) return facts.calibration ? "twin-calibration" : "twin";
  return "unavailable";
}

export const isTwinMode = (mode: SessionMode) => mode === "twin" || mode === "twin-calibration";

// ---- Runtime events -----------------------------------------------------------------------------------------
// The channel turns transport signals into these turn messages. They say what happened; the mode's operating
// instructions say how to respond.

export const USER_INACTIVE_EVENT = "[USER INACTIVE] The learner has been silent for 60 seconds.";

/** Twin calibration only: the trainer pressed "Feels off" (the page sends it as their message). */
export const CALIBRATION_FEEDBACK_EVENT = "[CALIBRATION FEEDBACK] The trainer pressed \"Feels off\" on your last reply.";
