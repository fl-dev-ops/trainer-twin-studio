import { NextResponse } from "next/server";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { listPendingWorkspaceCommands } from "@/lib/workspace-commands";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeRuntimeSession(id, token);
  if (!session || session.id !== id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ commands: await listPendingWorkspaceCommands(id) });
}
