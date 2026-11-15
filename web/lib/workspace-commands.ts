import { db } from "@/lib/db";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { resumeInterviewDocument, unusedResumeClaims } from "@/lib/resume-interview";
import { stableJson } from "@/lib/stable-json";

const COMMAND_LIFETIME_MS = 30_000;
const timedOut = { ok: false, error: "Timed out waiting for the browser" };

async function expireCommands(sessionId: string) {
  await db.workspaceCommand.updateMany({
    where: { sessionId, status: { in: ["pending", "running"] }, createdAt: { lt: new Date(Date.now() - COMMAND_LIFETIME_MS) } },
    data: { status: "failed", result: timedOut, completedAt: new Date() },
  });
}

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

  const previous = await db.workspaceCommand.findUnique({ where: { id: input.callId } });
  if (previous) {
    const saved = object(previous.input);
    const requested = object(input.payload);
    const normalized = input.tool === "surface" && saved.action === "open_pdf" && object(saved.payload).resumeDocument === true
      ? { action: requested.action, payload: { fileId: object(requested.payload).fileId, resumeDocument: true } }
      : input.payload ?? {};
    const sameInput = input.tool === "start_resume_question"
      ? saved.question === (typeof requested.question === "string" ? requested.question.trim() : requested.question) && object(saved.payload).claimId === requested.claimId
      : stableJson(previous.input) === stableJson(normalized);
    if (previous.sessionId !== session.id || previous.tool !== input.tool || !sameInput) throw new Error("Workspace command identity conflict");
  }
  let payload = previous?.input ?? input.payload;
  if (!previous && input.tool === "start_resume_question") {
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
  } else if (!previous && input.tool === "surface") {
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

  const stored = await db.workspaceCommand.upsert({
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
  if (stored.sessionId !== session.id || stored.tool !== input.tool || stableJson(stored.input) !== stableJson(payload ?? {})) {
    throw new Error("Workspace command identity conflict");
  }

  const finishCall = async () => {
    if (input.tool !== "finish_session") return;
    const grace = stored.createdAt.getTime() + 5_000 - Date.now();
    if (grace > 0) await new Promise((resolve) => setTimeout(resolve, grace));
    // Server-side end remains authoritative even if the browser has gone away.
    await closeInterviewSession(session.id, "completed");
  };
  const startedAt = Date.now();
  console.info(`[JOB:workspace-command] action=${input.tool} status=started session=${input.sessionId}`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await expireCommands(session.id);
    const command = await db.workspaceCommand.findFirst({
      where: { id: input.callId, sessionId: session.id },
      select: { status: true, result: true },
    });
    if (command && !["pending", "running"].includes(command.status)) {
      console.info(`[JOB:workspace-command] action=${input.tool} status=${command.status} elapsed_ms=${Date.now() - startedAt}`);
      await finishCall();
      return { status: command.status, result: command.result ?? { ok: command.status === "completed" } };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.warn(`[JOB:workspace-command] action=${input.tool} status=timeout elapsed_ms=${Date.now() - startedAt}`);
  await db.workspaceCommand.updateMany({
    where: { id: input.callId, sessionId: session.id, status: { in: ["pending", "running"] } },
    data: { status: "failed", result: timedOut, completedAt: new Date() },
  });
  await finishCall();
  return { status: "failed", result: timedOut };
}

export async function listPendingWorkspaceCommands(sessionId: string) {
  await expireCommands(sessionId);
  return db.workspaceCommand.findMany({
    where: { sessionId, status: { in: ["pending", "running"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, tool: true, input: true, createdAt: true },
  });
}

export async function claimWorkspaceCommand(sessionId: string, callId: string, consumerId: string) {
  await expireCommands(sessionId);
  await db.workspaceCommand.updateMany({
    where: { id: callId, sessionId, status: "pending", createdAt: { gte: new Date(Date.now() - COMMAND_LIFETIME_MS) } },
    data: { status: "running", claimedBy: consumerId },
  });
  return Boolean(await db.workspaceCommand.findFirst({
    where: { id: callId, sessionId, status: "running", claimedBy: consumerId, createdAt: { gte: new Date(Date.now() - COMMAND_LIFETIME_MS) } }, select: { id: true },
  }));
}

export async function completeWorkspaceCommand(sessionId: string, callId: string, consumerId: string, result: unknown, failed = false) {
  await expireCommands(sessionId);
  const updated = await db.workspaceCommand.updateMany({
    where: { id: callId, sessionId, status: "running", claimedBy: consumerId, createdAt: { gte: new Date(Date.now() - COMMAND_LIFETIME_MS) } },
    data: {
      status: failed ? "failed" : "completed",
      result: (result ?? { ok: !failed }) as object,
      completedAt: new Date(),
    },
  });
  if (updated.count > 0) return true;
  // Lost ACK responses are safe to retry; a timed-out command or a different browser cannot complete it.
  return Boolean(await db.workspaceCommand.findFirst({
    where: { id: callId, sessionId, claimedBy: consumerId, status: failed ? "failed" : "completed", result: { equals: (result ?? { ok: !failed }) as object } },
    select: { id: true },
  }));
}
