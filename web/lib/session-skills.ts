import { db } from "@/lib/db";
import { refusals } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { skillRefusals } from "@/lib/skills";

const runtimeVersionSelect = {
  id: true,
  skillId: true,
  status: true,
  indexStatus: true,
  format: true,
  skillText: true,
  manifest: true,
  artifacts: true,
  itemCount: true,
  skill: { select: { orgId: true, ownerSlug: true } },
} satisfies Prisma.SkillVersionSelect;

export type ManagedRoleplayRuntimeVersion = Prisma.SkillVersionGetPayload<{ select: typeof runtimeVersionSelect }>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateVersion(version: ManagedRoleplayRuntimeVersion) {
  if (version.status !== "ready" || version.indexStatus !== "ready"
    || !["builder-roleplay", "authored-roleplay"].includes(version.format)
    || typeof version.skillText !== "string" || !version.skillText.trim()
    || !version.manifest || typeof version.manifest !== "object" || Array.isArray(version.manifest)
    || typeof version.artifacts !== "string" || !version.artifacts
    || !Number.isSafeInteger(version.itemCount) || version.itemCount < 0) throw skillRefusals.unavailable();
  return version;
}

export async function resolveRoleplaySnapshotSkill(
  orgId: string,
  agent: { slug: string; primarySkillId: string | null; data: unknown },
  client: Prisma.TransactionClient = db,
) {
  const artifacts = record(agent.data).artifacts;
  if (!agent.primarySkillId || typeof artifacts !== "string" || !artifacts) throw skillRefusals.unavailable();
  const versions = await client.skillVersion.findMany({
    select: runtimeVersionSelect,
    where: {
      skillId: agent.primarySkillId,
      artifacts,
      skill: { orgId, ownerSlug: agent.slug },
      status: "ready",
      format: { in: ["builder-roleplay", "authored-roleplay"] },
    },
  });
  if (versions.length !== 1) throw skillRefusals.unavailable();
  return validateVersion(versions[0]);
}

export async function loadRoleplaySessionSkill(orgId: string, sessionId: string, agentSlug?: string) {
  const session = await db.interviewSession.findFirst({
    where: { id: sessionId, orgId, ...(agentSlug ? { agentSlug } : {}) },
    select: {
      agentSlug: true,
      skillPinsVersion: true,
      compiledSnapshot: true,
      skillPins: { select: {
        orgId: true,
        alias: true,
        position: true,
        version: { select: runtimeVersionSelect },
      } },
    },
  });
  if (!session) throw refusals.notFound();
  if (session.skillPinsVersion === null) return null;
  if (session.skillPinsVersion !== 1 || session.skillPins.length !== 1) throw skillRefusals.unavailable();
  const pin = session.skillPins[0];
  const version = validateVersion(pin.version);
  const snapshotAgent = record(record(session.compiledSnapshot).agent);
  const data = record(snapshotAgent.data);
  if (pin.orgId !== orgId || pin.alias !== session.agentSlug || pin.position !== 0
    || pin.version.skill.orgId !== orgId || pin.version.skill.ownerSlug !== session.agentSlug
    || snapshotAgent.primarySkillId !== version.skillId || data.artifacts !== version.artifacts
    || snapshotAgent.kind !== "ROLEPLAY") throw skillRefusals.unavailable();
  return {
    version,
    data: { ...data, skill: version.skillText, scenario: version.manifest, artifacts: version.artifacts },
  };
}
