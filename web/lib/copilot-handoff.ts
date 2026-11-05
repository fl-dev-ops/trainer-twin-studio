const SEED_KEY = "trainertwin:copilot-seed";

/**
 * The copilot chat's saved conversation, one per signed-in user and org (a person in two orgs has one in each).
 * Older builds kept a single browser-wide key; it is dropped on load.
 */
export const copilotSessionKey = (userId: string, orgId: string) => `trainertwin:copilot-session:v5:${userId}:${orgId}`;
export const copilotInputKey = (userId: string, orgId: string) => `trainertwin:copilot-input:v2:${userId}:${orgId}`;
export const LEGACY_COPILOT_KEYS = ["trainertwin:spec-copilot-session:v3", "trainertwin:spec-copilot-session:v4", "trainertwin:spec-copilot-input:v1"];

/**
 * Queue a first message for the copilot, then navigate to "/": CopilotChat starts a new conversation with it
 * instead of resuming the saved one.
 */
export function seedCopilot(text: string) {
  sessionStorage.setItem(SEED_KEY, JSON.stringify({ text, queuedAt: Date.now() }));
}

/** Whether a seed is waiting (the chat then starts fresh instead of resuming). */
export const hasCopilotSeed = () => sessionStorage.getItem(SEED_KEY) !== null;

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
