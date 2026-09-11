import { NextResponse } from "next/server";
import { pumpIngestionOutbox } from "@/lib/ingestion-queue";
import { processNextQueuedPersonaSource } from "@/lib/persona-analysis-queue";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret) return true;

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
    void processNextQueuedPersonaSource().catch((err) => {
      console.warn("[API:internal:ingestion:pump] persona queue pump tick failed:", err);
    });
    return NextResponse.json({ ok: true, recovered });
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
