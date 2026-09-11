import { NextResponse } from "next/server";
import { pumpIngestionOutbox } from "@/lib/ingestion-queue";
import { drainPersonaAnalysisQueue } from "@/lib/persona-analysis-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret) {
    // Fail-open only off-Vercel (local dev); production must set CRON_SECRET.
    return !process.env.VERCEL;
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${secret}`) return true;

  const internalHeader = request.headers.get("x-internal-secret");
  if (internalHeader === secret) return true;

  return false;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
    const recovered = await pumpIngestionOutbox(limit);
    const personaResult = await drainPersonaAnalysisQueue().catch((err) => {
      console.warn("[API:internal:ingestion:pump] persona queue pump tick failed:", err);
      return { processed: false, error: String(err) };
    });
    return NextResponse.json({ ok: true, recovered, persona: personaResult });
  } catch (error) {
    console.error("[API:internal:ingestion:pump] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to pump ingestion outbox" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return POST(request);
}
