import { NextResponse } from "next/server";
import { expireUploads } from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel cron (daily): copilot uploads expire after 30 days; abandoned uploads are cleared (lib/uploads.ts). */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.INTERNAL_API_SECRET;
  // Fail-open only off-Vercel (local dev); production must set CRON_SECRET.
  if (!secret) return !process.env.VERCEL;
  return request.headers.get("authorization") === `Bearer ${secret}` || request.headers.get("x-internal-secret") === secret;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await expireUploads()) });
  } catch (error) {
    console.error("[API:internal:uploads:expire] failed:", error);
    return NextResponse.json({ error: "Expiry failed" }, { status: 500 });
  }
}

export const POST = GET;
