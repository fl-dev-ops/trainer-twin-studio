import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A workflow run's progress, readable by the org that started it: `<runId>.<signature>` (HMAC of org + run with
 * BETTER_AUTH_SECRET), so a run id alone, or another org's token, reads nothing (app/api/runs/[token]).
 */
const sign = (orgId: string, runId: string) =>
  createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "").update(`run:${orgId}:${runId}`).digest("base64url");

export const progressToken = (orgId: string, runId: string) => `${runId}.${sign(orgId, runId)}`;

/** The run id when the token belongs to this org, else null. */
export function progressRun(orgId: string, token: string) {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const runId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const wanted = Buffer.from(sign(orgId, runId));
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? runId : null;
}
