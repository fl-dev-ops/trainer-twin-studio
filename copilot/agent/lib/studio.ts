type StudioContext = {
  abortSignal: AbortSignal;
  session: {
    auth: {
      current: { principalId: string; principalType: string } | null;
      initiator: { principalId: string; principalType: string } | null;
    };
  };
};

const studioUrl = process.env.STUDIO_URL ?? "http://localhost:3000";

export async function callStudio<T>(payload: Record<string, unknown>, ctx: StudioContext): Promise<T> {
  return callStudioAs<T>(payload, organizationId(ctx.session), ctx.abortSignal);
}

/** The TrainerTwin organization attached to a conversation. */
export function organizationId(session: StudioContext["session"]): string {
  const principal = session.auth.initiator ?? session.auth.current;
  if (principal?.principalType !== "organization") throw new Error("No TrainerTwin organization is attached to this conversation");
  return principal.principalId;
}

/** Calls the Studio for an organization; usable where no tool context exists (instruction resolvers). */
export async function callStudioAs<T>(payload: Record<string, unknown>, orgId: string, signal?: AbortSignal): Promise<T> {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");

  const response = await fetch(new URL("/api/copilot/studio", studioUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-trainertwin-org-id": orgId,
    },
    body: JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? `Studio request failed (${response.status})`);
  return result as T;
}
