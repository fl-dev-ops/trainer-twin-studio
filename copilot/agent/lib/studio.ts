const studioUrl = process.env.STUDIO_URL ?? "http://localhost:3000";

export async function callStudio<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");

  const response = await fetch(new URL("/api/copilot/studio", studioUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? `Studio request failed (${response.status})`);
  return result as T;
}
