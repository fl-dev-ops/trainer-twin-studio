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
}) {
  const { agent, domain, context } = await sessionSnapshot(input.orgId, input.agentId, input.contextId);
  return db.interviewSession.create({
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
}) {
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
    if (input.contextId) {
      const context = await db.contextDocument.findFirst({
        where: { id: input.contextId, orgId: input.orgId },
        select: { id: true, name: true },
      });
      if (!context) throw new Error("Context not found");
      await db.interviewSession.update({
        where: { id: existing.id },
        data: { contextId: context.id, contextName: context.name },
      });
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
      contextId: input.contextId,
    });
    sessionId = created.id;
    code = created.shareCode;
  }

  const current = await db.interviewSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { agentId: true, contextId: true },
  });
  const snapshot = await sessionSnapshot(input.orgId, current.agentId, (input.contextId ?? current.contextId) ?? undefined);
  const compiledConfig = await getAgentConfigForAgent(current.agentId, input.orgId, (input.contextId ?? current.contextId) ?? undefined);
  const token = runtimeToken();
  const initialRuntimeState = initRuntimeState();
  const session = await db.interviewSession.update({
    where: { id: sessionId },
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
    select: { id: true, shareCode: true, agentSlug: true, status: true },
  });
  return { ...session, runtimeToken: token, shareCode: code };
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
