type StudioContext = {
  abortSignal: AbortSignal;
  session: {
    auth: {
      current: { principalId: string; principalType: string; attributes?: Record<string, unknown> } | null;
      initiator: { principalId: string; principalType: string } | null;
    };
  };
};

const studioUrl = process.env.STUDIO_URL ?? "http://localhost:3000";

export type RuntimeSession = { sessionId: string; token: string; anonymous: true };

export function runtimeFromContext(ctx: { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }): RuntimeSession | undefined {
  const attributes = ctx.session?.auth?.current?.attributes;
  if (attributes?.anonymous !== "1") return undefined;
  if (typeof attributes.sessionId !== "string" || typeof attributes.runtimeToken !== "string" || !attributes.runtimeToken) {
    throw new Error("Anonymous runtime credentials missing");
  }
  return { sessionId: attributes.sessionId, token: attributes.runtimeToken, anonymous: true };
}

const PUBLIC_ACTIONS = new Set(["authorizeRuntimeSession", "getSessionContext", "searchScenarioItems", "finishSession", "recordTurnEvidence"]);

export async function authorizeRuntimeSession(orgId: string, sessionId: string, token?: string, signal?: AbortSignal) {
  const result = await studioFetch<{ valid?: boolean; anonymous?: boolean }>(orgId, {
    action: "authorizeRuntimeSession", sessionId, ...(token ? { token } : {}),
  }, signal, token ? { sessionId, token, anonymous: true } : undefined);
  if (result?.valid !== true || typeof result.anonymous !== "boolean" || (result.anonymous && !token)) {
    throw new Error("Runtime session unauthorized");
  }
  return result.anonymous;
}

export async function callStudio<T>(payload: Record<string, unknown>, ctx: StudioContext): Promise<T> {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  const principal = ctx.session.auth.initiator ?? ctx.session.auth.current;
  if (principal?.principalType !== "organization") throw new Error("No TrainerTwin organization is attached to this conversation");

  return studioFetch<T>(principal.principalId, payload, ctx.abortSignal, runtimeFromContext(ctx));
}

/** Plain studio call without an eve session context (instruction resolvers, channels). */
export async function studioFetch<T>(orgId: string, payload: Record<string, unknown>, signal?: AbortSignal, runtime?: RuntimeSession): Promise<T> {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  if (runtime && !PUBLIC_ACTIONS.has(String(payload.action))) throw new Error("Action unavailable for anonymous sessions");

  const response = await fetch(new URL("/api/copilot/studio", studioUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-trainertwin-org-id": orgId,
      ...(runtime ? {
        "x-trainertwin-session-id": runtime.sessionId,
        "x-trainertwin-runtime-token": runtime.token,
      } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? `Studio request failed (${response.status})`);
  return result as T;
}
