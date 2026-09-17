import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { initRuntimeState } from "@/lib/runtime/runtime";
import { getAgentConfigForAgent } from "@/lib/specs";

const shareCode = () => randomBytes(9).toString("base64url");
const runtimeToken = () => randomBytes(24).toString("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export type SessionEndStatus = "completed" | "abandoned";

export function resolveSessionEndStatus(current: string, requested: SessionEndStatus): SessionEndStatus {
  return current === "completed" ? "completed" : requested;
}

function jsonRecord(value: Prisma.JsonValue | Prisma.InputJsonValue | undefined): Record<string, Prisma.InputJsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.InputJsonValue>
    : {};
}

export function shouldStoreSessionTranscript(current: Prisma.JsonValue, incoming: Prisma.InputJsonValue | undefined) {
  return !(Array.isArray(current) && current.length > 0) && Array.isArray(incoming) && incoming.length > 0;
}

export function mergeSessionEvidence(
  current: Prisma.JsonValue,
  incoming: Prisma.InputJsonValue | undefined,
): Prisma.InputJsonObject | undefined {
  return incoming ? { ...jsonRecord(current), ...jsonRecord(incoming) } : undefined;
}

export async function finalizeInterviewSession(input: {
  sessionId: string;
  requestedStatus?: SessionEndStatus;
  transcript?: Prisma.InputJsonValue;
  evidence?: Prisma.InputJsonValue;
  s3AudioKey?: string;
}) {
  return db.$transaction(async (tx) => {
    const existing = await tx.interviewSession.findUnique({
      where: { id: input.sessionId },
      select: { status: true, endedAt: true, transcript: true, evidence: true, reportStatus: true },
    });
    if (!existing) return null;

    let becameCompleted = false;
    if (input.requestedStatus) {
      const finalStatus = resolveSessionEndStatus(existing.status, input.requestedStatus);
      const transitioned = await tx.interviewSession.updateMany({
        where: {
          id: input.sessionId,
          status: { not: "completed" },
        },
        data: { status: finalStatus },
      });
      becameCompleted = finalStatus === "completed" && transitioned.count === 1;
    }

    const storeTranscript = shouldStoreSessionTranscript(existing.transcript, input.transcript);
    const mergedEvidence = mergeSessionEvidence(existing.evidence, input.evidence);

    const updated = await tx.interviewSession.update({
      where: { id: input.sessionId },
      data: {
        ...(input.requestedStatus ? { endedAt: existing.endedAt ?? new Date(), runtimeTokenHash: null } : {}),
        ...(storeTranscript ? { transcript: input.transcript } : {}),
        ...(mergedEvidence ? { evidence: mergedEvidence } : {}),
        ...(input.s3AudioKey ? { s3AudioKey: input.s3AudioKey } : {}),
      },
      select: { id: true, status: true, transcript: true, evidence: true, reportStatus: true },
    });

    if (input.requestedStatus) {
      await tx.rolePlayAssignment.deleteMany({ where: { sessionId: input.sessionId } });
    }

    return {
      ...updated,
      previousStatus: existing.status,
      finalStatus: updated.status,
      becameCompleted,
      transcriptAvailable: Array.isArray(updated.transcript) && updated.transcript.length > 0,
    };
  });
}

async function sessionSnapshot(orgId: string, agentId: string, contextId?: string | null) {
  const [agent, context] = await Promise.all([
    db.agent.findFirst({
      where: { id: agentId, orgId },
      include: { persona: { select: { slug: true, version: true } } },
    }),
    contextId
      ? db.contextDocument.findFirst({ where: { id: contextId, orgId }, select: { id: true, name: true } })
      : Promise.resolve(null),
  ]);
  if (!agent) throw new Error("Agent not found");
  if (contextId && !context) throw new Error("Context not found");
  const domain = await db.domain.findFirst({
    where: { slug: agent.domainSlug, orgId },
    select: { slug: true, version: true },
  });
  if (!domain) throw new Error("Agent domain not found");
  return { agent, domain, context };
}

export async function createAssignedSession(input: {
  orgId: string;
  userId: string;
  agentId: string;
  contextId?: string | null;
  contextIds?: string[] | null;
}) {
  const docIds = Array.from(new Set([...(input.contextIds ?? []), ...(input.contextId ? [input.contextId] : [])])).filter(Boolean);
  if (docIds.length) {
    const accessibleCount = await db.contextDocument.count({
      where: {
        id: { in: docIds },
        orgId: input.orgId,
        ownerUserId: input.userId,
      },
    });
    if (accessibleCount !== docIds.length) throw new Error("Context not found");
  }
  const primaryId = docIds[0] ?? input.contextId;
  const { agent, domain, context } = await sessionSnapshot(input.orgId, input.agentId, primaryId);
  return db.$transaction(async (tx) => {
    const created = await tx.interviewSession.create({
      data: {
        orgId: input.orgId,
        userId: input.userId,
        agentId: agent.id,
        shareCode: shareCode(),
        personaSlug: agent.persona.slug,
        personaVersion: agent.persona.version,
        agentSlug: agent.slug,
        agentVersion: agent.version,
        domainSlug: domain.slug,
        domainVersion: domain.version,
        contextId: context?.id,
        contextName: context?.name,
        status: "assigned",
      },
      select: { id: true, shareCode: true, agentSlug: true, status: true },
    });
    if (docIds.length) {
      await tx.interviewSessionDocument.createMany({
        data: docIds.map((documentId) => ({ sessionId: created.id, documentId })),
        skipDuplicates: true,
      });
    }
    return created;
  });
}

export async function attachAssignmentSession(assignmentId: string, input: {
  orgId: string;
  userId: string;
  agentId: string;
}) {
  const session = await createAssignedSession(input);
  try {
    await db.rolePlayAssignment.update({ where: { id: assignmentId }, data: { sessionId: session.id } });
    return session;
  } catch (error) {
    await db.interviewSession.delete({ where: { id: session.id } });
    throw error;
  }
}

export async function revokeAssignedSession(sessionId: string | null | undefined) {
  if (!sessionId) return;
  await db.interviewSession.updateMany({
    where: { id: sessionId, status: "assigned" },
    data: { status: "revoked", endedAt: new Date(), runtimeTokenHash: null },
  });
}

export async function activateSession(input: {
  orgId: string;
  userId: string;
  shareCode?: string;
  agentSlug?: string;
  contextId?: string | null;
  contextIds?: string[] | null;
}) {
  const docIds = Array.from(new Set([...(input.contextIds ?? []), ...(input.contextId ? [input.contextId] : [])])).filter(Boolean);
  const primaryId = docIds[0] ?? input.contextId;
  let sessionId: string;
  let code: string;
  if (input.shareCode) {
    const existing = await db.interviewSession.findUnique({
      where: { shareCode: input.shareCode },
      select: { id: true, orgId: true, userId: true, agentId: true, contextId: true, status: true, shareCode: true },
    });
    if (!existing || existing.orgId !== input.orgId || existing.userId !== input.userId || existing.status !== "assigned") {
      return null;
    }
    if (docIds.length) {
      const validDocs = await db.contextDocument.findMany({
        where: {
          id: { in: docIds },
          orgId: input.orgId,
          ownerUserId: input.userId,
        },
        select: { id: true, name: true },
      });
      if (validDocs.length !== docIds.length) throw new Error("Context not found");
      await db.$transaction([
        db.interviewSessionDocument.createMany({
          data: docIds.map((documentId) => ({ sessionId: existing.id, documentId })),
          skipDuplicates: true,
        }),
        db.interviewSession.update({
          where: { id: existing.id },
          data: { contextId: validDocs[0].id, contextName: validDocs[0].name },
        }),
      ]);
    }
    sessionId = existing.id;
    code = existing.shareCode;
  } else {
    if (!input.agentSlug) throw new Error("Agent is required");
    const agent = await db.agent.findFirst({
      where: { slug: input.agentSlug, orgId: input.orgId },
      select: { id: true },
    });
    if (!agent) throw new Error("Agent not found");
    await db.interviewSession.updateMany({
      where: { orgId: input.orgId, userId: input.userId, agentId: agent.id, status: "active" },
      data: { status: "abandoned", endedAt: new Date(), runtimeTokenHash: null },
    });
    const created = await createAssignedSession({
      orgId: input.orgId,
      userId: input.userId,
      agentId: agent.id,
      contextId: primaryId,
      contextIds: docIds,
    });
    sessionId = created.id;
    code = created.shareCode;
  }

  const current = await db.interviewSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      agentId: true,
      contextId: true,
      documents: { select: { documentId: true } },
    },
  });
  const attachedIds = Array.from(new Set([
    ...docIds,
    ...(current.contextId ? [current.contextId] : []),
    ...current.documents.map((d) => d.documentId),
  ])).filter(Boolean);
  const activePrimaryId = attachedIds[0] ?? undefined;
  const snapshot = await sessionSnapshot(input.orgId, current.agentId, activePrimaryId);
  const compiledConfig = await getAgentConfigForAgent(current.agentId, input.orgId, activePrimaryId, attachedIds);
  const token = runtimeToken();
  const initialRuntimeState = initRuntimeState();
  const claimed = await db.interviewSession.updateMany({
    where: { id: sessionId, status: "assigned" },
    data: {
      status: "active",
      startedAt: new Date(),
      runtimeTokenHash: tokenHash(token),
      personaSlug: snapshot.agent.persona.slug,
      personaVersion: snapshot.agent.persona.version,
      agentSlug: snapshot.agent.slug,
      agentVersion: snapshot.agent.version,
      domainSlug: snapshot.domain.slug,
      domainVersion: snapshot.domain.version,
      compiledSnapshot: compiledConfig ? JSON.parse(JSON.stringify(compiledConfig)) : undefined,
      runtimeState: JSON.parse(JSON.stringify(initialRuntimeState)),
      runtimeRevision: 0,
      lastCompletion: Prisma.DbNull,
    },
  });
  if (claimed.count === 0) return null;

  return {
    id: sessionId,
    shareCode: code,
    agentSlug: snapshot.agent.slug,
    status: "active",
    runtimeToken: token,
  };
}

export async function authorizeRuntimeSession(idOrToken: string, tokenParam?: string) {
  const token = tokenParam ? tokenParam : idOrToken;
  if (!token) return null;
  const hash = tokenHash(token);
  const session = await db.interviewSession.findFirst({
    where: {
      runtimeTokenHash: hash,
      ...(tokenParam && idOrToken ? { id: idOrToken } : {}),
    },
    select: {
      id: true,
      orgId: true,
      userId: true,
      agentId: true,
      contextId: true,
      status: true,
      runtimeTokenHash: true,
      compiledSnapshot: true,
      runtimeState: true,
      runtimeRevision: true,
      lastCompletion: true,
      evidence: true,
      transcript: true,
    },
  });
  if (!session?.runtimeTokenHash || !["assigned", "active"].includes(session.status)) return null;
  return session;
}
