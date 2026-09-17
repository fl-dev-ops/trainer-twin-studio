import { NextResponse } from "next/server";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { completeWorkspaceCommand } from "@/lib/workspace-commands";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; callId: string }> },
) {
  const { id, callId } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeRuntimeSession(id, token);
  if (!session || session.id !== id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { result?: unknown; status?: unknown; uiState?: unknown } | null;
  const failed = body?.status === "failed";
  await completeWorkspaceCommand(id, callId, body?.result ?? { ok: !failed }, failed);
  return NextResponse.json({ ok: true });
}
