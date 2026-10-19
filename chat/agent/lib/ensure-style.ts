import { styleCacheState } from "./plan-state";
import { studioFetch } from "./studio";
import { fetchStyleCache } from "./style-cache";

const inFlight = new Map<string, Promise<void>>();

/**
 * Fills the session's style cache once. Call only from tool calls whose speech is already playing
 * (bridged reply / question), so the 1.5–3.7 s lookup never delays the trainer's first word.
 */
export async function ensureStyleCache(ctx: any): Promise<void> {
  if (styleCacheState.get().cache) return;
  const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
  const attributes = (ctx.session?.auth?.current?.attributes ?? {}) as Record<string, string | undefined>;
  const sessionId = attributes.sessionId;
  if (!orgId || !sessionId) return;

  const key = `${orgId}:${sessionId}`;
  const pending = inFlight.get(key) ?? (async () => {
    const personaSlug = attributes.personaSlug
      ?? (await studioFetch<{ persona?: { slug?: string } }>(orgId, { action: "getSessionContext", sessionId }).catch(() => null))?.persona?.slug;
    if (!personaSlug) return;
    const cache = await fetchStyleCache(personaSlug, (payload) => studioFetch(orgId, payload));
    if (Object.keys(cache).length) styleCacheState.update(() => ({ cache }));
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  await pending;
}
