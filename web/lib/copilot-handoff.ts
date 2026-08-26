const SEED_KEY = "trainertwin:copilot-seed";
const SESSION_KEY = "trainertwin:spec-copilot-session:v3";

/**
 * Queue a first message for the spec copilot and reset its conversation,
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
