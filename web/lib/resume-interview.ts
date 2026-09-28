import { db } from "@/lib/db";

const ELIGIBLE_KINDS = ["project", "experience", "impact", "architecture", "technology"];

export async function resumeInterviewDocument(orgId: string, sessionId: string) {
  const session = await db.interviewSession.findFirst({
    where: { id: sessionId, orgId },
    select: {
      id: true,
      contextId: true,
      compiledSnapshot: true,
      documents: { orderBy: { createdAt: "asc" }, select: { documentId: true } },
    },
  });
  if (!session) throw new Error("Session not found");
  const snapshot = session.compiledSnapshot as {
    agent?: { data?: { config?: { interview?: { type?: string } } } };
  } | null;
  const isResume = snapshot?.agent?.data?.config?.interview?.type === "resume";
  const documentId = session.contextId ?? session.documents[0]?.documentId ?? null;
  return { isResume, documentId };
}

export async function eligibleResumeClaims(orgId: string, sessionId: string) {
  const session = await resumeInterviewDocument(orgId, sessionId);
  if (!session.isResume || !session.documentId) throw new Error("Resume interview document not found");
  const claims = await db.resumeClaim.findMany({
    where: {
      documentId: session.documentId,
      document: { orgId },
      kind: { in: ELIGIBLE_KINDS },
    },
    orderBy: { claimNo: "asc" },
    select: { id: true, documentId: true, claimNo: true, section: true, kind: true, text: true, anchor: true, metric: true },
  });
  return claims.filter((claim) => claim.anchor.trim().length > 0);
}

export async function unusedResumeClaims(orgId: string, sessionId: string) {
  const [claims, completed] = await Promise.all([
    eligibleResumeClaims(orgId, sessionId),
    db.workspaceCommand.findMany({
      where: { sessionId, tool: "start_resume_question", status: "completed" },
      select: { input: true, result: true },
    }),
  ]);
  const usedIds = new Set(completed.flatMap((command) => {
    const result = command.result as { status?: string } | null;
    const input = command.input as { payload?: { claimId?: string } };
    return (["highlighted", "not_found", "located", "claim_cancelled"].includes(result?.status ?? "")) && input.payload?.claimId
      ? [input.payload.claimId]
      : [];
  }));
  return claims.filter((claim) => !usedIds.has(claim.id));
}
