import { timingSafeEqual } from "node:crypto";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Vercel cron and internal callers: `Authorization: Bearer <CRON_SECRET>` (or `x-internal-secret`). Without a secret
 * only local development is let in; production must set CRON_SECRET.
 */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret) return !process.env.VERCEL;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return same(bearer, secret) || same(request.headers.get("x-internal-secret") ?? "", secret);
}
