/**
 * What kind of session this is, decided once. Two modes, each with variants:
 *
 *   twin                the trainer's twin advises a learner on a real situation (all-skills or one skill twin)
 *   twin-calibration    the same twin while its trainer tests it; only the "Feels off" feedback differs
 *   roleplay-client     skill-based role plays: the builder's client or a recording-authored role
 *   unavailable         nothing to run (an agent that is neither a role play, a twin nor a playbook, e.g. an old
 *                       interview not converted yet): the session says so and ends
 *   legacy-playbook     a SKILL.md run as a session script (scenario-ingest); no prod agent uses it.
 *                       shortcut: kept only so those agents still run, delete with formatPlaybookSession once retired.
 *
 * The prompt layers (lib/compose-instructions.ts), the runtime event texts (below) and the role-play tool guard
 * (lib/session-mode-lookup.ts) all follow from this one answer.
 */
export type SessionMode = "twin" | "twin-calibration" | "roleplay-client" | "unavailable" | "legacy-playbook";

/** The agent facts that decide the mode; SessionSpecs has them, and so does a raw agent once classified. */
export type ModeFacts = { roleplay?: unknown; twin?: unknown; playbook?: unknown; calibration?: boolean };

export function sessionMode(facts: ModeFacts): SessionMode {
  if (facts.roleplay) return "roleplay-client";
  if (facts.twin) return facts.calibration ? "twin-calibration" : "twin";
  if (facts.playbook) return "legacy-playbook";
  return "unavailable";
}

export const isTwinMode = (mode: SessionMode) => mode === "twin" || mode === "twin-calibration";

// ---- Runtime events -----------------------------------------------------------------------------------------
// The channel turns transport signals into these turn messages. They say what happened; the mode's operating
// instructions say how to respond. The interview texts are frozen: they carry their own directive, as before.

const INTERVIEW_USER_INACTIVE =
  "[USER INACTIVE] The learner has been silent for 60 seconds. Adapt to the current moment in the session. Do not advance the interview or ask a new interview question.";

export function userInactiveEvent(mode: SessionMode): string {
  return mode === "legacy-playbook"
    ? INTERVIEW_USER_INACTIVE
    : "[USER INACTIVE] The learner has been silent for 60 seconds.";
}

/** Twin calibration only: the trainer pressed "Feels off" (the page sends it as their message). */
export const CALIBRATION_FEEDBACK_EVENT = "[CALIBRATION FEEDBACK] The trainer pressed \"Feels off\" on your last reply.";
