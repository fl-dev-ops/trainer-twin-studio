import { errorResponse } from "@/lib/errors";
import { practiceRefusals } from "@/lib/practice";
import { NextResponse } from "next/server";
import { authorizeBrowserSession } from "@/lib/interview-sessions";
import { completeWorkspaceCommand } from "@/lib/workspace-commands";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; callId: string }> },
) {
  const { id, callId } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeBrowserSession(id, token);
  if (!session || session.id !== id) return errorResponse(practiceRefusals.runtimeTokenInvalid());
  const body = await request.json().catch(() => null) as { result?: unknown; status?: unknown; uiState?: unknown } | null;
  const failed = body?.status === "failed";
  await completeWorkspaceCommand(id, callId, body?.result ?? { ok: !failed }, failed);
  return NextResponse.json({ ok: true });
}
