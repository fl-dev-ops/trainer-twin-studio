import { errorResponse } from "@/lib/errors";
import { practiceRefusals } from "@/lib/practice";
import { NextResponse } from "next/server";
import { authorizeBrowserSession } from "@/lib/interview-sessions";
import { listPendingWorkspaceCommands } from "@/lib/workspace-commands";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeBrowserSession(id, token);
  if (!session || session.id !== id) return errorResponse(practiceRefusals.runtimeTokenInvalid());
  return NextResponse.json({ commands: await listPendingWorkspaceCommands(id) });
}
