import { cronAuthorized } from "@/lib/cron";
import { NextResponse } from "next/server";
import { expireUploads } from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel cron (daily): copilot uploads expire after 30 days; abandoned uploads are cleared (lib/uploads.ts). */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await expireUploads()) });
  } catch (error) {
    console.error("[API:internal:uploads:expire] failed:", error);
    return NextResponse.json({ error: "Expiry failed" }, { status: 500 });
  }
}

export const POST = GET;
