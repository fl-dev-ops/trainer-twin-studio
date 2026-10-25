import { timingSafeEqual } from "node:crypto";
import { recordUsage, usageInputSchema } from "@/lib/usage";

export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Usage ingest for internal producers (LiveKit agent, chat, copilot). See lib/usage.ts. */
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = usageInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid usage payload", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }

  const result = await recordUsage(parsed.data);
  if ("error" in result) {
    const status = result.error === "unknown_session" ? 404 : 400;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json({ ok: true, inserted: result.inserted });
}
