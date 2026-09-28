import { db } from "@/lib/db";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { resumeInterviewDocument, unusedResumeClaims } from "@/lib/resume-interview";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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

  let payload = input.payload;
  if (input.tool === "start_resume_question") {
    const request = object(input.payload);
    const claimId = typeof request.claimId === "string" ? request.claimId : "";
    const question = typeof request.question === "string" ? request.question.trim() : "";
    if (!question || question.length > 500 || (question.match(/\?/g) ?? []).length !== 1) {
      throw new Error("Resume main question must contain one question and be at most 500 characters");
    }
    const claim = (await unusedResumeClaims(input.orgId, input.sessionId)).find((item) => item.id === claimId);
    if (!claim) throw new Error("Eligible resume claim not found");
    payload = {
      action: "highlight_document",
      question,
      payload: {
        fileId: claim.documentId,
        claimId: claim.id,
        highlightQuery: claim.anchor,
        exactHighlight: true,
        resumeDocument: true,
      },
    };
  } else if (input.tool === "surface") {
    const session = await resumeInterviewDocument(input.orgId, input.sessionId);
    if (session.isResume) {
      const request = object(input.payload);
      const action = request.action;
      if (action === "highlight_document" || action === "highlight_pdf") {
        throw new Error("Resume highlights require start_resume_question with a claim ID");
      }
      if (action === "open_pdf") {
        const surface = object(request.payload);
        if (!session.documentId || surface.fileId !== session.documentId) {
          throw new Error("Resume surface document does not match this session");
        }
        payload = { action, payload: { fileId: session.documentId, resumeDocument: true } };
      }
    }
  }

  await db.workspaceCommand.upsert({
    where: { id: input.callId },
    create: {
      id: input.callId,
      sessionId: session.id,
      tool: input.tool,
      input: (payload ?? {}) as object,
      status: "pending",
    },
    update: {},
  });

  const startedAt = Date.now();
  console.info(`[JOB:workspace-command] action=${input.tool} status=started session=${input.sessionId}`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const command = await db.workspaceCommand.findUnique({
      where: { id: input.callId },
      select: { status: true, result: true },
    });
    if (command && command.status !== "pending") {
      console.info(`[JOB:workspace-command] action=${input.tool} status=${command.status} elapsed_ms=${Date.now() - startedAt}`);
      if (input.tool === "finish_session") await closeInterviewSession(session.id, "completed");
      return { status: command.status, result: command.result ?? { ok: command.status === "completed" } };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn(`[JOB:workspace-command] action=${input.tool} status=timeout elapsed_ms=${Date.now() - startedAt}`);
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
