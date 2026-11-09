import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness for container health checks: the process is up (GET /api/health).
 * Readiness: GET /api/health?ready=1 also checks the database. Keep the Swarm health check on liveness so a slow
 * database does not flap the container.
 */
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("ready") === "1") {
    try {
      await db.$queryRaw`SELECT 1`;
    } catch {
      return NextResponse.json({ ok: false, db: false }, { status: 503 });
    }
    return NextResponse.json({ ok: true, db: true });
  }
  return NextResponse.json({ ok: true });
}
