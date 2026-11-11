import { createHash, createHmac, randomBytes } from "node:crypto";
import { assignmentMatchesUser } from "@/lib/assignments";
import { db, withLock } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { practicePerson, practiceRefusals, startAllowance } from "@/lib/practice";
import { Prisma } from "@/lib/generated/prisma/client";
import { ensureDeployment, type DeliveryMode } from "@/lib/deployments";
import { initRuntimeState } from "@/lib/runtime/runtime";
import { getAgentConfigForAgent } from "@/lib/specs";
import { isStudioRole } from "@/lib/org";
import { twinAccessByAgent, twinAccessByCode } from "@/lib/twin-access";
import { pinTwinSkills, TWIN_SOURCE } from "@/lib/twins";
import { beforeSettings, usesBeforeSettings } from "@/lib/context-upload";
import { MinutesError, minutesLock, writeSessionUsage } from "@/lib/minutes";
import { scheduleOrgUsage } from "@/lib/schedule-org-credits";
import { orgCredits } from "@/lib/org-credits";
import { BEFORE_UPLOAD_REFUSED, uploadAllowed } from "@/lib/context-upload";

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

/**
 * Ends (or updates) a call in one transaction, its usage row included (specs/practice.md rule 8), then reports org
 * usage to Meteroid. Pass `tx` to end it inside a caller's transaction; the caller then reports `usageOrgId`.
 */
export async function finalizeInterviewSession(input: Parameters<typeof finalizeSessionRow>[0]) {
  const finalized = await db.$transaction((tx) => finalizeSessionRow(input, tx));
  if (finalized?.usageOrgId) await scheduleOrgUsage(finalized.usageOrgId);
  return finalized;
}

export async function finalizeSessionRow(input: {
  sessionId: string;
  requestedStatus?: SessionEndStatus;
  transcript?: Prisma.InputJsonValue;
  evidence?: Prisma.InputJsonValue;
  s3AudioKey?: string;
  /** The voice agent's full transcript replaces the browser's provisional one (twin sessions). */
  replaceTranscript?: boolean;
}, tx: Prisma.TransactionClient) {
  {
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

    const storeTranscript = input.replaceTranscript
      ? Array.isArray(input.transcript) && input.transcript.length > 0
      : shouldStoreSessionTranscript(existing.transcript, input.transcript);
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

    // The call's charge, in the transaction that ends it: one row per call, however many times it is finalized.
    const usage = input.requestedStatus ? await writeSessionUsage(tx, input.sessionId) : { report: null };

    return {
      ...updated,
      previousStatus: existing.status,
      finalStatus: updated.status,
      becameCompleted,
      usageOrgId: usage.report,
      transcriptAvailable: Array.isArray(updated.transcript) && updated.transcript.length > 0,
    };
  }
}

async function sessionSnapshot(orgId: string, agentId: string, contextId?: string | null, contextIds: string[] = []) {
  const docIds = Array.from(new Set([...contextIds, ...(contextId ? [contextId] : [])]));
  const [agent, documents] = await Promise.all([
    db.agent.findFirst({
      // Archived agents start no new sessions (their past sessions stay).
      where: { id: agentId, orgId, archivedAt: null },
      include: { persona: { select: { slug: true, version: true } } },
    }),
    docIds.length
      ? db.contextDocument.findMany({
          where: { id: { in: docIds }, orgId, status: "ready" },
          select: { id: true, name: true, ownerUserId: true, kind: true, mimeType: true, size: true },
        })
      : Promise.resolve([]),
  ]);
  if (!agent) throw refusals.notFound(); // archived or gone (specs/practice.md rule 2)
  if (documents.length !== docIds.length) throw new Error("Context not found");
  // Before the call only a PDF or an image up to 10 MB, for every agent (the pickers say the same).
  if (documents.some((doc) => !uploadAllowed(doc, "before"))) throw new Error(BEFORE_UPLOAD_REFUSED);
  return { agent, documents, docIds };
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

/**
 * Starts (or resumes) a call (specs/practice.md rules 1–6). Everything that can refuse is checked first: the person
 * (an enabled member), what they start (role-play link, twin code, twin by slug or deployment), its mode, the live
 * agent and its documents. Then one transaction under the org's credits lock re-checks the person, ends their other
 * live calls (charged), checks the allowance and creates the call; a refusal there rolls everything back, so nothing
 * is ended. After it commits: the replaced calls' end work, then the chat brain. Null: an invalid or used link.
 */
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
  const person = await practicePerson(input.orgId, input.userId); // every session path goes through here
  const mode = input.mode ?? "voice";
  const studio = isStudioRole(person.role);
  const user = { id: input.userId, email: person.email };
  const requestedDocs = Array.from(new Set([...(input.contextIds ?? []), ...(input.contextId ? [input.contextId] : [])]));
  let assignmentId: string | null = null;
  let deploymentId: string;
  let agentId: string;
  let activationKey: string;
  // Twin sessions: the learner's assignment on that twin (null for admin/team trying it).
  let twin: { assignmentId: string | null } | null = null;

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
    // Not a role-play invite: a twin assignment code or a twin share link. Joining through a link happened when the
    // page opened (lib/pages/learner.ts); a call start never adds anyone (specs/practice.md rule 3).
    const access = await twinAccessByCode({ orgId: input.orgId, user, code: input.shareCode, join: false });
    if (!access) return null;
    twin = { assignmentId: access.assignmentId };
    agentId = access.agentId;
    deploymentId = (await ensureDeployment(input.orgId, agentId)).id;
    activationKey = input.idempotencyKey
      ? `twin:${access.assignmentId}:${input.idempotencyKey}`
      : `direct:${randomBytes(18).toString("base64url")}`;
  } else if (input.shareCode) {
    const found = roleplayInvite;
    if (
      !found
      || !assignmentMatchesUser(found, { id: input.userId })
      || !["pending", "used"].includes(found.status)
      || found.deployment.status !== "active"
    ) return null;
    if (!found.deployment.allowedModes.split(",").includes(mode)) throw new Error(`Deployment does not allow ${mode} sessions`);
    assignmentId = found.id;
    deploymentId = found.deployment.id;
    agentId = found.deployment.agent.id;
    // A role play link starts a new call each time (practice is limited only by the learner's minutes); a call still
    // live on it is resumed instead, so a dropped connection or a reload continues the same conversation.
    const live = await db.interviewSession.findFirst({
      where: { assignmentId: found.id, userId: input.userId, status: { in: ["activating", "active"] } },
      orderBy: { createdAt: "desc" },
      select: { activationKey: true },
    });
    activationKey = live?.activationKey ?? `assignment:${found.id}:${randomBytes(18).toString("base64url")}`;
  } else {
    const found = input.deploymentKey
      ? await db.deployment.findFirst({ where: { publicKey: input.deploymentKey, orgId: input.orgId, status: "active" } })
      : null;
    if (found) {
      deploymentId = found.id;
      agentId = found.agentId;
    } else {
      if (!input.agentSlug) throw refusals.invalidInput("Say which agent to start.");
      const agent = await db.agent.findFirst({ where: { slug: input.agentSlug, orgId: input.orgId, archivedAt: null }, select: { id: true } });
      if (!agent) throw refusals.notFound();
      deploymentId = (await ensureDeployment(input.orgId, agent.id)).id;
      agentId = agent.id;
    }
    activationKey = input.idempotencyKey
      ? `deployment:${deploymentId}:${input.idempotencyKey}`
      : `direct:${randomBytes(18).toString("base64url")}`;

    // A twin started directly (portal, talk page, API key): admin and team without an assignment, learners need one.
    const agentRow = await db.agent.findFirst({ where: { id: agentId, orgId: input.orgId }, select: { kind: true } });
    if (agentRow?.kind === "TWIN") {
      twin = { assignmentId: studio ? null : (await twinAccessByAgent({ orgId: input.orgId, user, agentId })).assignmentId };
    }
  }
  // All twin sessions go through LiveKit (also enforced by a DB trigger); the agent cuts metered calls at the deadline.
  if (twin && mode !== "voice") throw practiceRefusals.voiceOnly();
  if (!studio && mode !== "voice") throw new MinutesError("Practice sessions are voice only", 400);

  const existing = await db.interviewSession.findUnique({ where: { activationKey } });
  if (existing && ["activating", "active"].includes(existing.status)) {
    const token = runtimeToken(existing.id);
    await db.interviewSession.update({ where: { id: existing.id }, data: { runtimeTokenHash: tokenHash(token) } });
    // A resumed learner call keeps its deadline: what's left of the minutes it started with.
    const secondsLeft = existing.allowedSeconds == null
      ? null
      : Math.max(0, existing.allowedSeconds - Math.floor((Date.now() - (existing.startedAt ?? existing.createdAt).getTime()) / 1000));
    return { id: existing.id, agentSlug: existing.agentSlug, status: existing.status, mode: existing.mode as DeliveryMode, runtimeToken: token, secondsLeft };
  }
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
  // Documents at the start only when the agent's before settings turn pre-session uploads on (twins, new role plays).
  if (snapshot.docIds.length && usesBeforeSettings(snapshot.agent.data, snapshot.agent.kind) && !beforeSettings(snapshot.agent.data).preUpload) {
    throw refusals.invalidInput(snapshot.agent.kind === "TWIN" ? "This twin does not take documents" : "This role play does not take documents");
  }
  const primaryId = snapshot.docIds[0];
  const primary = snapshot.documents.find((document) => document.id === primaryId);
  const compiledConfig = await getAgentConfigForAgent(agentId, input.orgId, primaryId, snapshot.docIds);
  // The all-skills twin keeps the skills (and versions) it started with for the whole session.
  const twinSkills = snapshot.agent.kind === "TWIN" && (snapshot.agent.data as Record<string, unknown> | null)?.source === TWIN_SOURCE
    ? await pinTwinSkills(input.orgId, snapshot.agent.personaId)
    : undefined;
  const sessionSnapshotData = compiledConfig || twinSkills ? { ...(compiledConfig ?? {}), ...(twinSkills ? { twinSkills } : {}) } : undefined;
  // The org's balance from Meteroid now, before the lock (no network calls while it's held).
  if (studio && mode === "voice") await orgCredits(input.orgId, { fresh: true });

  const { session, replaced, usageOrgIds } = await withLock([minutesLock(input.orgId)], async (tx) => {
    const current = await practicePerson(input.orgId, input.userId, tx); // disabled or moved since the checks above
    // One live call per person (rule 5): their others end now, charged, before the balance is counted.
    const live = await tx.interviewSession.findMany({
      where: { orgId: input.orgId, userId: input.userId, status: { in: ["activating", "active"] } },
      select: { id: true },
    });
    const ended = [];
    for (const row of live) ended.push(await finalizeSessionRow({ sessionId: row.id, requestedStatus: "abandoned" }, tx));
    const { allowedSeconds, chargesOrg } = mode === "voice" ? await startAllowance(input.orgId, current, tx) : { allowedSeconds: null, chargesOrg: false };
    const created = await tx.interviewSession.create({
      data: {
        orgId: input.orgId,
        userId: input.userId,
        agentId,
        deploymentId,
        assignmentId,
        twinAssignmentId: twin?.assignmentId ?? null,
        allowedSeconds,
        chargesOrg,
        shareCode: shareCode(),
        activationKey,
        mode,
        personaSlug: snapshot.agent.persona.slug,
        personaVersion: snapshot.agent.persona.version,
        agentSlug: snapshot.agent.slug,
        agentVersion: snapshot.agent.version,
        contextId: primary?.id,
        contextName: primary?.name,
        status: "activating",
        compiledSnapshot: sessionSnapshotData ? JSON.parse(JSON.stringify(sessionSnapshotData)) : undefined,
        runtimeState: JSON.parse(JSON.stringify(initRuntimeState())),
        lastCompletion: Prisma.DbNull,
      },
    });
    if (snapshot.docIds.length) {
      await tx.interviewSessionDocument.createMany({
        data: snapshot.docIds.map((documentId) => ({ sessionId: created.id, documentId })),
      });
    }
    return {
      session: created,
      replaced: ended.filter((row) => row && row.previousStatus !== row.finalStatus).map((row) => row!.id),
      usageOrgIds: ended.map((row) => row?.usageOrgId).filter((id): id is string => Boolean(id)),
    };
  }, { timeout: 15_000, maxWait: 15_000 });

  // The calls this one replaced: their end work (room, report) and Meteroid's usage report.
  if (usageOrgIds.length) await scheduleOrgUsage(input.orgId);
  if (replaced.length) {
    const { startSessionEnd } = await import("@/lib/session-end");
    for (const id of replaced) await startSessionEnd(id);
  }

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

  // secondsLeft: the call must end after this many seconds (metered calls; null = not metered).
  return { id: session.id, agentSlug: session.agentSlug, status: "active", mode, runtimeToken: token, secondsLeft: session.allowedSeconds };
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
