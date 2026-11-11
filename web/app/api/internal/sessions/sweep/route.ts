import { cronAuthorized } from "@/lib/cron";
import { errorResponse, refusals } from "@/lib/errors";
import { sweepStaleCalls } from "@/lib/session-lifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel cron (every 5 minutes, specs/practice.md rule 7): ends calls left live past their limit. */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return errorResponse(refusals.signedOut());
  return Response.json({ ok: true, ended: await sweepStaleCalls() });
}

export const POST = GET;
