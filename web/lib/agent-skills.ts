import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { skillRefusals } from "@/lib/skills";
import type { SessionSkillCatalogEntry } from "@/lib/session-skills";

/**
 * Supporting skills (specs/agents.md): library skills an agent draws on after its main skill, in order, each switchable.
 * At session start the active ones become the session's catalog and pins, at their current ready versions, so a later
 * edit never changes a call in progress. Null: the agent has none attached (a twin not yet merged keeps its persona-wide
 * catalog; lib/twins).
 */
export async function supportingCatalog(orgId: string, agentId: string, client: Prisma.TransactionClient = db, start = 0) {
  const attached = await client.agentSkill.findMany({
    where: { agentId, orgId },
    orderBy: { position: "asc" },
    select: {
      active: true,
      skill: { select: { id: true, orgId: true, ownerSlug: true, currentVersion: { select: { id: true, version: true, status: true, indexStatus: true, format: true } } } },
    },
  });
  if (!attached.length) return null;
  const catalog: SessionSkillCatalogEntry[] = [];
  const pins: { skillVersionId: string; alias: string; position: number }[] = [];
  for (const row of attached) {
    if (!row.active) continue;
    const version = row.skill.currentVersion;
    // An attached skill that isn't ready (re-indexing, failed) is left out of new calls rather than failing them.
    if (!version || version.status !== "ready" || version.indexStatus !== "ready" || !["twin", "legacy-twin"].includes(version.format)) continue;
    if (row.skill.orgId !== orgId) throw skillRefusals.unavailable();
    pins.push({ skillVersionId: version.id, alias: row.skill.ownerSlug, position: start + catalog.length });
    catalog.push({ slug: row.skill.ownerSlug, version: version.version, skillVersionId: version.id });
  }
  return { catalog, pins };
}

/** Replaces an agent's supporting skills (ids in order, each with its switch). */
export async function setSupportingSkills(orgId: string, agentId: string, skills: { skillId: string; active: boolean }[], tx: Prisma.TransactionClient) {
  await tx.agentSkill.deleteMany({ where: { agentId, orgId } });
  if (skills.length) {
    await tx.agentSkill.createMany({
      data: skills.map((skill, index) => ({ agentId, orgId, skillId: skill.skillId, active: skill.active, position: index + 1 })),
    });
  }
}

/** The org's published twin skills an agent can draw on, for the editors' pickers. */
export async function supportingSkillChoices(orgId: string) {
  const skills = await db.skill.findMany({
    where: { orgId, currentVersion: { status: "ready", format: { in: ["twin", "legacy-twin"] } } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, ownerSlug: true, currentVersion: { select: { itemCount: true } } },
  });
  return skills.map((skill) => ({ id: skill.id, slug: skill.ownerSlug, name: skill.name, items: skill.currentVersion?.itemCount ?? 0 }));
}
