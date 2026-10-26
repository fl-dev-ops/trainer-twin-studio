import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { assignmentMatchesUser } from "@/lib/assignments";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { ensureDeployment, type DeliveryMode } from "@/lib/deployments";
import { initRuntimeState } from "@/lib/runtime/runtime";
import { getAgentConfigForAgent } from "@/lib/specs";
import { assertUserInOrg } from "@/lib/org-lock";
import { isStudioRole, LEARNER_ROLE } from "@/lib/org";
import { TwinAccessError, twinAccessByAgent, twinAccessByCode } from "@/lib/twin-access";

const shareCode = () => randomBytes(18).toString("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const runtimeToken = (sessionId: string) => {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  return createHmac("sha256", secret).update(`session:${sessionId}`).digest("base64url");
};

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
      select: { status: true, endedAt: true, transcript: true, evidence: true, reportStatus: true, assignmentId: true },
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
      select: { id: true, status: true, transcript: true, evidence: true, reportStatus: true, assignmentId: true },
    });

    if (
      existing.assignmentId
      && input.requestedStatus
      && (updated.status === "completed" || updated.status === "abandoned")
    ) {
      await tx.rolePlayAssignment.updateMany({
        where: { id: existing.assignmentId, status: "pending" },
        data: { status: "used", usedAt: existing.endedAt ?? new Date() },
      });
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

async function sessionSnapshot(orgId: string, agentId: string, contextId?: string | null, contextIds: string[] = []) {
  const docIds = Array.from(new Set([...contextIds, ...(contextId ? [contextId] : [])]));
  const [agent, documents] = await Promise.all([
    db.agent.findFirst({
      where: { id: agentId, orgId },
      include: { persona: { select: { slug: true, version: true } } },
    }),
    docIds.length
      ? db.contextDocument.findMany({
          where: { id: { in: docIds }, orgId },
          select: { id: true, name: true, ownerUserId: true },
        })
      : Promise.resolve([]),
  ]);
  if (!agent) throw new Error("Agent not found");
  if (documents.length !== docIds.length) throw new Error("Context not found");
  const domain = await db.domain.findFirst({
    where: { slug: agent.domainSlug, orgId },
    select: { slug: true, version: true },
  });
  if (!domain) throw new Error("Agent domain not found");
  return { agent, domain, documents, docIds };
}

async function initializeChatSession(input: { sessionId: string; orgId: string; mode: DeliveryMode }) {
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!secret) throw new Error("COPILOT_SERVICE_SECRET is not configured");
  const url = new URL("/internal/sessions", process.env.CHAT_URL ?? "http://localhost:2000");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-trainertwin-org-id": input.orgId,
    },
    body: JSON.stringify({ sessionId: input.sessionId, mode: input.mode, contextVersion: 1 }),
  });
  if (!response.ok) throw new Error(`Chat runtime initialization failed (${response.status})`);
}

/** Legacy direct invitation helper retained for local scripts; assignments never call it. */
export async function createAssignedSession(input: {
  orgId: string;
  userId: string;
  agentId: string;
  contextId?: string | null;
  contextIds?: string[] | null;
}) {
  const snapshot = await sessionSnapshot(input.orgId, input.agentId, input.contextId, input.contextIds ?? []);
  const primary = snapshot.documents.find((document) => document.id === snapshot.docIds[0]);
  return db.$transaction(async (tx) => {
    const created = await tx.interviewSession.create({
      data: {
        orgId: input.orgId,
        userId: input.userId,
        agentId: snapshot.agent.id,
        shareCode: shareCode(),
        personaSlug: snapshot.agent.persona.slug,
        personaVersion: snapshot.agent.persona.version,
        agentSlug: snapshot.agent.slug,
        agentVersion: snapshot.agent.version,
        domainSlug: snapshot.domain.slug,
        domainVersion: snapshot.domain.version,
        contextId: primary?.id,
        contextName: primary?.name,
        status: "assigned",
      },
      select: { id: true, shareCode: true, agentSlug: true, status: true },
    });
    if (snapshot.docIds.length) {
      await tx.interviewSessionDocument.createMany({
        data: snapshot.docIds.map((documentId) => ({ sessionId: created.id, documentId })),
        skipDuplicates: true,
      });
    }
    return created;
  });
}

export async function activateSession(input: {
  orgId: string;
  userId: string;
  userEmail?: string;
  shareCode?: string;
  agentSlug?: string;
  deploymentKey?: string;
  contextId?: string | null;
  contextIds?: string[] | null;
  mode?: DeliveryMode;
  idempotencyKey?: string;
}) {
  await assertUserInOrg(input.userId, input.orgId); // single-org lock: every session path goes through here
  const mode = input.mode ?? "voice";
  const requestedDocs = Array.from(new Set([...(input.contextIds ?? []), ...(input.contextId ? [input.contextId] : [])]));
  let assignmentId: string | null = null;
  let assignmentStatus: string | null = null;
  let deploymentId: string;
  let agentId: string;
  let activationKey: string;
  // Twin sessions: the assignment that pays for the minutes (null for admin/team, who have no limit).
  let twin: { assignmentId: string | null; secondsLeft: number | null } | null = null;
  const person = { id: input.userId, email: input.userEmail ?? "" };

  const roleplayInvite = input.shareCode
    ? await db.rolePlayAssignment.findFirst({
        where: { shareCode: input.shareCode, orgId: input.orgId },
        include: {
          member: { select: { userId: true } },
          deployment: { include: { agent: { select: { id: true } } } },
        },
      })
    : null;

  if (input.shareCode && !roleplayInvite) {
    // Not a role-play invite: a twin assignment code or a twin share link (joining creates the user's assignment).
    const access = await twinAccessByCode({ orgId: input.orgId, user: person, code: input.shareCode, join: true });
    if (!access) return null;
    twin = { assignmentId: access.assignmentId, secondsLeft: access.secondsLeft };
    agentId = access.agentId;
    deploymentId = (await ensureDeployment(input.orgId, agentId)).id;
    activationKey = input.idempotencyKey
      ? `twin:${access.assignmentId}:${input.idempotencyKey}`
      : `direct:${randomBytes(18).toString("base64url")}`;
  } else if (input.shareCode) {
    const found = roleplayInvite;
    if (
      !found
      || !assignmentMatchesUser(found, { id: input.userId, email: input.userEmail ?? "" })
      || !["pending", "used"].includes(found.status)
      || found.deployment.status !== "active"
    ) return null;
    if (found.expiresAt <= new Date() && found.status === "pending") {
      await db.rolePlayAssignment.update({ where: { id: found.id }, data: { status: "expired" } });
      return null;
    }
    if (!found.deployment.allowedModes.split(",").includes(mode)) throw new Error(`Deployment does not allow ${mode} sessions`);
    assignmentId = found.id;
    assignmentStatus = found.status;
    deploymentId = found.deployment.id;
    agentId = found.deployment.agent.id;
    activationKey = `assignment:${found.id}:${found.shareCode}`;
  } else {
    const found = input.deploymentKey
      ? await db.deployment.findFirst({ where: { publicKey: input.deploymentKey, orgId: input.orgId, status: "active" } })
      : null;
    if (found) {
      deploymentId = found.id;
      agentId = found.agentId;
    } else {
      if (!input.agentSlug) throw new Error("Agent is required");
      const agent = await db.agent.findFirst({ where: { slug: input.agentSlug, orgId: input.orgId }, select: { id: true } });
      if (!agent) throw new Error("Agent not found");
      deploymentId = (await ensureDeployment(input.orgId, agent.id)).id;
      agentId = agent.id;
    }
    activationKey = input.idempotencyKey
      ? `deployment:${deploymentId}:${input.idempotencyKey}`
      : `direct:${randomBytes(18).toString("base64url")}`;

    // A twin started directly (portal, talk page, API key): admin and team without limits, others need their assignment.
    const agentRow = await db.agent.findFirst({ where: { id: agentId, orgId: input.orgId }, select: { kind: true } });
    if (agentRow?.kind === "TWIN") {
      const membership = await db.member.findFirst({
        where: { userId: input.userId, organizationId: input.orgId },
        select: { role: true },
      });
      if (isStudioRole(membership?.role)) {
        twin = { assignmentId: null, secondsLeft: null };
      } else {
        const access = await twinAccessByAgent({ orgId: input.orgId, user: person, agentId });
        twin = { assignmentId: access.assignmentId, secondsLeft: access.secondsLeft };
      }
    }
  }
  // All twin sessions go through LiveKit (also enforced by a DB trigger).
  if (twin && mode !== "voice") throw new TwinAccessError("Twin sessions are voice only", 400);

  const existing = await db.interviewSession.findUnique({ where: { activationKey } });
  if (existing && ["activating", "active"].includes(existing.status)) {
    const token = runtimeToken(existing.id);
    await db.interviewSession.update({ where: { id: existing.id }, data: { runtimeTokenHash: tokenHash(token) } });
    return { id: existing.id, agentSlug: existing.agentSlug, status: existing.status, mode: existing.mode as DeliveryMode, runtimeToken: token };
  }
  if (assignmentId && assignmentStatus !== "pending") return null;
  if (existing?.status === "failed") {
    await db.interviewSession.delete({ where: { id: existing.id } });
  } else if (existing) {
    if (assignmentId && (existing.status === "completed" || existing.status === "abandoned")) {
      await db.rolePlayAssignment.updateMany({
        where: { id: assignmentId, status: "pending" },
        data: { status: "used", usedAt: existing.endedAt ?? new Date() },
      });
    }
    return null;
  }

  const snapshot = await sessionSnapshot(input.orgId, agentId, input.contextId, requestedDocs);
  for (const document of snapshot.documents) {
    if (document.ownerUserId && document.ownerUserId !== input.userId) throw new Error("Context not found");
  }
  // An invited learner (role-play invite, twin assignment or twin link) joins the org as a `user` on first start.
  // The single-org lock above already refused people bound to another org.
  if (assignmentId || twin?.assignmentId) await ensureLearnerMember(input.orgId, input.userId);
  const primaryId = snapshot.docIds[0];
  const primary = snapshot.documents.find((document) => document.id === primaryId);
  const compiledConfig = await getAgentConfigForAgent(agentId, input.orgId, primaryId, snapshot.docIds);
  const session = await db.$transaction(async (tx) => {
    if (!assignmentId) {
      await tx.interviewSession.updateMany({
        where: { orgId: input.orgId, userId: input.userId, agentId, status: "active" },
        data: { status: "abandoned", endedAt: new Date(), runtimeTokenHash: null },
      });
    }
    const created = await tx.interviewSession.create({
      data: {
        orgId: input.orgId,
        userId: input.userId,
        agentId,
        deploymentId,
        assignmentId,
        twinAssignmentId: twin?.assignmentId ?? null,
        shareCode: shareCode(),
        activationKey,
        mode,
        personaSlug: snapshot.agent.persona.slug,
        personaVersion: snapshot.agent.persona.version,
        agentSlug: snapshot.agent.slug,
        agentVersion: snapshot.agent.version,
        domainSlug: snapshot.domain.slug,
        domainVersion: snapshot.domain.version,
        contextId: primary?.id,
        contextName: primary?.name,
        status: "activating",
        compiledSnapshot: compiledConfig ? JSON.parse(JSON.stringify(compiledConfig)) : undefined,
        runtimeState: JSON.parse(JSON.stringify(initRuntimeState())),
        lastCompletion: Prisma.DbNull,
      },
    });
    if (snapshot.docIds.length) {
      await tx.interviewSessionDocument.createMany({
        data: snapshot.docIds.map((documentId) => ({ sessionId: created.id, documentId })),
      });
    }
    return created;
  });

  const token = runtimeToken(session.id);
  try {
    await initializeChatSession({ sessionId: session.id, orgId: input.orgId, mode });
    await db.$transaction([
      db.interviewSession.update({
        where: { id: session.id },
        data: { status: "active", startedAt: new Date(), runtimeTokenHash: tokenHash(token) },
      }),
      ...(assignmentId
        ? [db.rolePlayAssignment.update({
            where: { id: assignmentId },
            data: { status: "used", usedAt: new Date() },
          })]
        : []),
    ]);
  } catch (error) {
    await db.interviewSession.update({
      where: { id: session.id },
      data: { status: "failed", endedAt: new Date(), runtimeTokenHash: null },
    });
    throw error;
  }

  // twinSecondsLeft: the call must end after this many seconds (twin assignments only; null = no limit).
  return { id: session.id, agentSlug: session.agentSlug, status: "active", mode, runtimeToken: token, twinSecondsLeft: twin?.secondsLeft ?? null };
}

/** Gives a learner with no membership role `user` in the org (no-op when they already belong to it). */
async function ensureLearnerMember(orgId: string, userId: string) {
  const member = await db.member.findFirst({ where: { userId, organizationId: orgId }, select: { id: true } });
  if (member) return;
  await db.member.create({ data: { id: randomUUID(), organizationId: orgId, userId, role: LEARNER_ROLE, createdAt: new Date() } })
    .catch(async (error: unknown) => {
      // A parallel start created it first.
      if (!(await db.member.findFirst({ where: { userId, organizationId: orgId }, select: { id: true } }))) throw error;
    });
}

export async function authorizeRuntimeSession(idOrToken: string, tokenParam?: string) {
  const token = tokenParam || idOrToken;
  if (!token) return null;
  return db.interviewSession.findFirst({
    where: {
      runtimeTokenHash: tokenHash(token),
      ...(tokenParam && idOrToken ? { id: idOrToken } : {}),
      status: { in: ["activating", "active", "closing"] },
    },
    select: {
      id: true,
      orgId: true,
      userId: true,
      agentId: true,
      contextId: true,
      status: true,
      mode: true,
      runtimeTokenHash: true,
      compiledSnapshot: true,
      runtimeState: true,
      runtimeRevision: true,
      lastCompletion: true,
      evidence: true,
      transcript: true,
      livekitRoom: true,
      livekitDispatchId: true,
      videoEgressId: true,
    },
  });
}
