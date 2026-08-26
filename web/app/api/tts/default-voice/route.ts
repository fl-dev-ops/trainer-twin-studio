import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Fallback voice for the Pipecat agent when an agent spec has no voice assigned.
 * ponytail: unauthenticated like the rest of the agent-facing API; add a shared
 * service secret when this leaves local development.
 */
export async function GET() {
  const voice = await db.voice.findFirst({
    where: { status: "ready" },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });
  if (!voice) return NextResponse.json({ error: "No voices available" }, { status: 404 });
  return NextResponse.json({ voice });
}
