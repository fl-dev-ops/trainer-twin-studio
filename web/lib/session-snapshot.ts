import { Prisma } from "@/lib/generated/prisma/client";
import { withLock } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { getAgentConfigForAgent } from "@/lib/specs";
import { readAgentSkillVersion } from "@/lib/skill-history";
import { ownershipLock, skillOwnership } from "@/lib/skill-ownership";
import { skillRefusals } from "@/lib/skills";

function snapshotRecord(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Lazy legacy snapshots preserve saved identities and serialize with ownership coverage checks. */
export async function ensureSessionSnapshot(sessionId: string, orgId: string): Promise<Record<string, unknown>> {
  return withLock([ownershipLock(orgId)], async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "InterviewSession" WHERE "id" = ${sessionId} AND "orgId" = ${orgId} FOR UPDATE`;
    const session = await tx.interviewSession.findFirst({
      where: { id: sessionId, orgId },
      select: {
        id: true, agentId: true, agentSlug: true, agentVersion: true, personaSlug: true, personaVersion: true,
        contextId: true, compiledSnapshot: true, skillPinsVersion: true,
        documents: { select: { documentId: true } },
      },
    });
    if (!session) throw refusals.notFound();
    const existing = snapshotRecord(session.compiledSnapshot);
    if (existing) return existing;
    if (session.skillPinsVersion !== null) throw skillRefusals.unavailable();
    const config = await getAgentConfigForAgent(
      session.agentId, orgId, session.contextId ?? undefined,
      session.documents.map((row) => row.documentId), tx,
      { agentVersion: session.agentVersion, personaSlug: session.personaSlug, personaVersion: session.personaVersion },
    );
    if (!config) throw skillRefusals.unavailable();
    if (config.agent.slug !== session.agentSlug) throw skillRefusals.unavailable();
    const data = config.agent.data && typeof config.agent.data === "object" && !Array.isArray(config.agent.data) ? config.agent.data : {};
    if (config.agent.kind === "TWIN" && "source" in data && data.source === "twin") throw skillRefusals.unavailable();
    if ((config.agent.primarySkillId || "skill" in data) && (await skillOwnership(orgId, tx)).mode === "managed"
      && !await readAgentSkillVersion(orgId, config.agent.id, session.agentVersion, tx)) throw skillRefusals.unavailable();
    const serialized: Prisma.InputJsonObject = JSON.parse(JSON.stringify(config));
    await tx.interviewSession.update({ where: { id: session.id }, data: { compiledSnapshot: serialized } });
    return serialized;
  });
}
