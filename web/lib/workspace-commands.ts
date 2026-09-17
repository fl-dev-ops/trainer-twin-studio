import { db } from "@/lib/db";
import { closeInterviewSession } from "@/lib/session-lifecycle";

export async function enqueueWorkspaceCommand(input: {
  orgId: string;
  sessionId: string;
  callId: string;
  tool: string;
  payload: unknown;
}) {
  const session = await db.interviewSession.findFirst({
    where: { id: input.sessionId, orgId: input.orgId, status: { in: ["activating", "active"] } },
    select: { id: true },
  });
  if (!session) throw new Error("Session not found");

  await db.workspaceCommand.upsert({
    where: { id: input.callId },
    create: {
      id: input.callId,
      sessionId: session.id,
      tool: input.tool,
      input: (input.payload ?? {}) as object,
      status: "pending",
    },
    update: {},
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const command = await db.workspaceCommand.findUnique({
      where: { id: input.callId },
      select: { status: true, result: true },
    });
    if (command && command.status !== "pending") {
      if (input.tool === "finish_session") await closeInterviewSession(session.id, "completed");
      return { status: command.status, result: command.result ?? { ok: command.status === "completed" } };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (input.tool === "finish_session") {
    await closeInterviewSession(session.id, "completed");
    return { status: "completed", result: { ok: true } };
  }
  return { status: "pending", result: { ok: false, error: "Timed out waiting for the browser" } };
}

export async function listPendingWorkspaceCommands(sessionId: string) {
  return db.workspaceCommand.findMany({
    where: { sessionId, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, tool: true, input: true, createdAt: true },
  });
}

export async function completeWorkspaceCommand(sessionId: string, callId: string, result: unknown, failed = false) {
  const updated = await db.workspaceCommand.updateMany({
    where: { id: callId, sessionId, status: "pending" },
    data: {
      status: failed ? "failed" : "completed",
      result: (result ?? { ok: !failed }) as object,
      completedAt: new Date(),
    },
  });
  return updated.count > 0;
}
