import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";

export const dynamic = "force-dynamic";

const SURFACES = new Set(["code", "canvas", "pdf", "image", "presentation"]);

type UiState = {
  active: string | null;
  key?: string | null;
  updatedAt: string;
};

/**
 * Candidate-side report of what is currently on screen. Written by the browser
 * whenever a workspace surface opens or closes; read by /api/copilot/studio
 * getSessionContext so the agent brain sees ground truth instead of guessing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeRuntimeSession(id, token);
  if (!session || session.id !== id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const raw = body as { active?: unknown; key?: unknown };
  const active = typeof raw.active === "string" && SURFACES.has(raw.active) ? raw.active : null;
  const key = typeof raw.key === "string" ? raw.key.slice(0, 120) : null;

  const uiState: UiState = { active, key, updatedAt: new Date().toISOString() };

  const current = (session.runtimeState ?? {}) as Record<string, unknown>;
  const nextRuntimeState = { ...current, uiState };

  await db.interviewSession.update({
    where: { id: session.id },
    data: { runtimeState: nextRuntimeState as object },
  });

  return NextResponse.json({ ok: true, uiState });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeRuntimeSession(id, token);
  if (!session || session.id !== id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const runtimeState = (session.runtimeState ?? {}) as Record<string, unknown>;
  return NextResponse.json({ uiState: runtimeState.uiState ?? null });
}
