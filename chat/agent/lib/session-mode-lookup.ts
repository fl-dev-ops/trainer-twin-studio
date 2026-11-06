import { isCalibrationSession, scenarioPlaybook, twinSessionPlaybooks } from "./brain";
import { roleplaySkill } from "./roleplay";
import { sessionMode, type SessionMode } from "./session-mode";
import { studioFetch } from "./studio";

/**
 * The session mode for code that runs outside the instructions (the channel, tools), cached per session. The
 * instructions prime it from the context they already loaded (instructions/session-spec.ts), so this rarely fetches.
 */

type GuardContext = {
  session?: {
    auth?: {
      current?: { principalId?: string; attributes?: Record<string, unknown> } | null;
      initiator?: { principalId?: string } | null;
    };
  };
};

type SessionRef = { orgId?: string; sessionId?: string; agentSlug?: string };

const CACHE_TTL_MS = 10 * 60_000;
/** On a failed lookup: what sessions were before modes existed (not a role play, interview event texts). */
const FALLBACK: SessionMode = "roleplay-interview";
const modeCache = new Map<string, { at: number; value: Promise<SessionMode> }>();
const cacheKey = (orgId: string, sessionId?: string, agentSlug?: string) => `${orgId}:${sessionId ?? ""}:${agentSlug ?? ""}`;

async function fetchMode(orgId: string, sessionId?: string, agentSlug?: string): Promise<SessionMode> {
  const { agent } = await studioFetch<{ agent?: { kind?: string | null; slug?: string; data?: unknown } | null }>(orgId, { action: "getSessionContext", sessionId, agentSlug });
  const data = (agent?.data ?? {}) as Record<string, unknown>;
  const kind = agent?.kind === "TWIN" || agent?.kind === "ROLEPLAY" ? agent.kind : undefined;
  const twin = twinSessionPlaybooks(agent ? { ...agent, kind, data } : null, undefined);
  return sessionMode({
    roleplay: roleplaySkill(agent?.kind, data),
    twin,
    playbook: scenarioPlaybook(kind, data),
    calibration: twin ? await isCalibrationSession(orgId, sessionId) : false,
  });
}

/** The mode of a session; FALLBACK when it can't be looked up (then the next call retries). */
export async function sessionModeFor({ orgId, sessionId, agentSlug }: SessionRef): Promise<SessionMode> {
  if (!orgId || (!sessionId && !agentSlug)) return FALLBACK;
  const key = cacheKey(orgId, sessionId, agentSlug);
  const cached = modeCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = fetchMode(orgId, sessionId, agentSlug).catch((error: unknown) => {
    console.error("[session-mode] lookup failed", error);
    modeCache.delete(key);
    return FALLBACK;
  });
  modeCache.set(key, { at: Date.now(), value });
  if (modeCache.size > 500) {
    const oldest = modeCache.keys().next().value;
    if (oldest) modeCache.delete(oldest);
  }
  return value;
}

/** Seeds the cache from a context the session already loaded (avoids a second fetch). */
export function primeSessionMode(orgId: string, sessionId: string | undefined, agentSlug: string | undefined, mode: SessionMode) {
  if (!sessionId && !agentSlug) return;
  modeCache.set(cacheKey(orgId, sessionId, agentSlug), { at: Date.now(), value: Promise.resolve(mode) });
}

/** The session behind a tool call. */
function refOf(ctx: GuardContext): SessionRef {
  const auth = ctx.session?.auth;
  const attributes = auth?.current?.attributes ?? {};
  return {
    orgId: auth?.initiator?.principalId ?? auth?.current?.principalId,
    sessionId: typeof attributes.sessionId === "string" ? attributes.sessionId : undefined,
    agentSlug: typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined,
  };
}

/** Whether the current eve session runs a client role play. */
export async function isRoleplaySession(ctx: GuardContext): Promise<boolean> {
  return (await sessionModeFor(refOf(ctx))) === "roleplay-client";
}

export const ROLEPLAY_DISABLED = {
  disabled: true,
  reason: "Not available in client role play. Stay in character and answer as the client.",
} as const;

/** The disabled result for role-play sessions, or null to run the tool normally. */
export async function roleplayGuard(ctx: GuardContext): Promise<typeof ROLEPLAY_DISABLED | null> {
  return (await isRoleplaySession(ctx)) ? ROLEPLAY_DISABLED : null;
}

/** Test hook. */
export function clearSessionModeCache() {
  modeCache.clear();
}
