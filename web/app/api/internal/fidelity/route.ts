import { timingSafeEqual } from "node:crypto";
import { fidelityReportSchema } from "@/lib/fidelity-report";
import { fidelityReportKey, putObject } from "@/lib/s3";

export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  const parsed = fidelityReportSchema.safeParse(await request.json().catch(() => null));
  if (!orgId || !parsed.success || parsed.data.orgId !== orgId) {
    return Response.json({ error: "Invalid fidelity report" }, { status: 400 });
  }

  const reportId = parsed.data.createdAt.replace(/[^0-9]/g, "").slice(0, 14);
  const body = JSON.stringify(parsed.data);
  await Promise.all([
    putObject(fidelityReportKey(orgId), body, "application/json"),
    putObject(fidelityReportKey(orgId, reportId), body, "application/json"),
  ]);
  return Response.json({ reportId });
}
