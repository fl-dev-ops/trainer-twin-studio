const SEED_KEY = "trainertwin:copilot-seed";
/** The copilot chat's saved conversation (CopilotChat): clearing it makes a seed start a new conversation. */
export const COPILOT_SESSION_KEY = "trainertwin:spec-copilot-session:v4";
const SESSION_KEY = COPILOT_SESSION_KEY;

/**
 * Queue a first message for the copilot and reset its conversation,
 * then navigate to "/" so CopilotChat picks the seed up on mount.
 */
export function seedCopilot(text: string) {
  sessionStorage.setItem(SEED_KEY, JSON.stringify({ text, queuedAt: Date.now() }));
  localStorage.removeItem(SESSION_KEY);
}

/** Consume the queued seed, if any. */
export function takeCopilotSeed(): string | undefined {
  const raw = sessionStorage.getItem(SEED_KEY);
  if (!raw) return undefined;
  sessionStorage.removeItem(SEED_KEY);
  try {
    return JSON.parse(raw).text;
  } catch {
    return undefined;
  }
}
