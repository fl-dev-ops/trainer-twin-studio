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
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  const principal = ctx.session.auth.initiator ?? ctx.session.auth.current;
  if (principal?.principalType !== "organization") throw new Error("No TrainerTwin organization is attached to this conversation");

  const response = await fetch(new URL("/api/copilot/studio", studioUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-trainertwin-org-id": principal.principalId,
    },
    body: JSON.stringify(payload),
    signal: ctx.abortSignal,
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? `Studio request failed (${response.status})`);
  return result as T;
}
