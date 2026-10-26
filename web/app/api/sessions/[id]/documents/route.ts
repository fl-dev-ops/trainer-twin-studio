import { z } from "zod";
import { twinSettingsFromAgentData } from "@/lib/context-upload";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { resolveSessionUser } from "@/lib/session-user";
import { documentManifestOf } from "@/lib/specs";

const bodySchema = z.object({ documentId: z.string().trim().min(1).max(100) }).strict();
const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/**
 * Attaches one of the learner's uploaded files to their running twin conversation, when the twin allows it.
 * Uses the settings pinned when the session started. The runtime reads the session's snapshot every turn,
 * so the file is listed from the next turn; the client also tells the twin its ID over the call chat.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give the documentId to attach" }, { status: 400 });

  const { id } = await params;
  const session = await db.interviewSession.findFirst({
    where: { id, orgId: org.id, userId: user.id, deletedAt: null },
    select: { status: true, compiledSnapshot: true, agent: { select: { kind: true, data: true } } },
  });
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  if (!["activating", "active"].includes(session.status)) return Response.json({ error: "This conversation has ended" }, { status: 409 });

  const snapshot = asRecord(session.compiledSnapshot);
  const pinnedAgentData = asRecord(snapshot?.agent)?.data ?? session.agent.data;
  if (session.agent.kind !== "TWIN" || !twinSettingsFromAgentData(pinnedAgentData).duringUpload) {
    return Response.json({ error: "Attaching files is turned off for this conversation" }, { status: 403 });
  }

  const doc = await db.contextDocument.findFirst({
    where: { id: parsed.data.documentId, orgId: org.id, ownerUserId: user.id },
    select: { id: true, name: true, kind: true, mimeType: true, size: true, manifest: true },
  });
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  const ids = Array.isArray(snapshot?.sessionDocumentIds) ? (snapshot.sessionDocumentIds as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const manifests = Array.isArray(snapshot?.documentManifests) ? (snapshot.documentManifests as unknown[]) : [];
  const nextSnapshot = snapshot && !ids.includes(doc.id)
    ? { ...snapshot, sessionDocumentIds: [...ids, doc.id], documentManifests: [...manifests, documentManifestOf(doc)] }
    : null;

  await db.$transaction([
    db.interviewSessionDocument.createMany({ data: [{ sessionId: id, documentId: doc.id }], skipDuplicates: true }),
    ...(nextSnapshot ? [db.interviewSession.update({ where: { id }, data: { compiledSnapshot: nextSnapshot as Prisma.InputJsonValue } })] : []),
  ]);
  return Response.json({ ok: true, id: doc.id, name: doc.name });
}
