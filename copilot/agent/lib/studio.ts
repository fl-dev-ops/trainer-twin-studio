// The web studio's copilot actions (web /api/internal/copilot-studio, web/lib/copilot-studio.ts): read twins, skills,
// role plays and knowledge; change settings; invite learners; archive / restore. Always for the organization this
// session belongs to (set by the web proxy), never one the model names.

import { sessionPrincipal, type TenantCtx } from "./tenant";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type StudioCtx = TenantCtx & { abortSignal?: AbortSignal };

export class StudioUnavailable extends Error {}

export async function studio<T = Record<string, unknown>>(ctx: StudioCtx, body: Record<string, unknown>, fetcher: Fetch = fetch, env = process.env): Promise<T> {
  const principal = sessionPrincipal(ctx);
  if (principal?.principalType !== "organization") throw new StudioUnavailable("This session is not attached to a TrainerTwin organization.");
  const userId = typeof principal.attributes?.userId === "string" ? principal.attributes.userId : "";
  if (!userId) throw new StudioUnavailable("This session has no signed-in trainer; open the copilot from the studio.");
  if (!env.STUDIO_URL || !env.SCENARIO_INGEST_SECRET) throw new StudioUnavailable("STUDIO_URL or SCENARIO_INGEST_SECRET is not configured.");
  const response = await fetcher(new URL("/api/internal/copilot-studio", env.STUDIO_URL).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SCENARIO_INGEST_SECRET}`,
      "content-type": "application/json",
      "x-trainertwin-org-id": principal.principalId,
      "x-trainertwin-user-id": userId,
    },
    body: JSON.stringify(body),
    signal: ctx.abortSignal,
  });
  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(String(result?.error ?? `The studio answered HTTP ${response.status}`));
  return result as T;
}

/** A tool's result: the studio's answer, or the error as data so the model can report it. */
export async function studioResult(ctx: StudioCtx, body: Record<string, unknown>) {
  try {
    return await studio(ctx, body);
  } catch (error) {
    return { error: (error as Error).message };
  }
}
