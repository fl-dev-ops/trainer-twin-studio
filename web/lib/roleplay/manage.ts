import { type ToolSettings, toolSettings } from "@/lib/agent-tools";
import { type BeforeSettings, beforeSettings } from "@/lib/context-upload";
import { db, withLock } from "@/lib/db";
import { ownershipLock, packageFieldsOmitted, skillOwnership } from "@/lib/skill-ownership";
import { type RoleplayBuilder, roleplayBuilderFrom, roleplayBuilderSchema } from "@/lib/roleplay/skill";
import { ROLEPLAY_SOURCE, saveRoleplay, ScenarioIngestError } from "@/lib/scenario-ingest";
import { hydrateAgentSkill } from "@/lib/skill-history";

/**
 * Settings and Tools are patched under the save lock. Builder script changes publish a new version;
 * scripts for other role plays are changed through their own publishing flow.
 */
export async function updateRoleplay(
  orgId: string,
  slug: string,
  patch: { builder?: Partial<RoleplayBuilder>; before?: Partial<BeforeSettings>; tools?: Partial<ToolSettings> },
) {
  const where = { orgId, slug, kind: "ROLEPLAY" as const, archivedAt: null };
  const notFound = () => new ScenarioIngestError(`Role play "${slug}" was not found`, 404);
  if (!patch.builder) {
    // Separate approval cards can execute together. Read each patch's starting state under the shared save lock.
    return withLock([ownershipLock(orgId), `agent:${slug}`], async (tx) => {
      const fresh = await tx.agent.findFirst({ where, select: { id: true, data: true, primarySkillId: true } });
      if (!fresh) throw notFound();
      const latest = (fresh.data && typeof fresh.data === "object" ? fresh.data : {}) as Record<string, unknown>;
      const managed = fresh.primarySkillId && (await skillOwnership(orgId, tx)).mode === "managed";
      await tx.agent.update({
        where: { id: fresh.id },
        data: { data: {
          ...(managed ? packageFieldsOmitted(latest) : latest),
          ...(patch.before ? { before: { ...beforeSettings(latest), ...patch.before } } : {}),
          ...(patch.tools ? { tools: { ...toolSettings(latest), ...patch.tools } } : {}),
        } },
      });
      return { slug, changed: true };
    });
  }

  const agent = await db.agent.findFirst({ where, select: { id: true, slug: true, version: true, primarySkillId: true, data: true } });
  if (!agent) throw notFound();
  if ((agent.data as { source?: unknown } | null)?.source !== ROLEPLAY_SOURCE) {
    throw new ScenarioIngestError("This role play does not use builder fields: update its script through its publishing flow", 400);
  }
  const before = patch.before && { ...beforeSettings(agent.data), ...patch.before };
  const tools = patch.tools && { ...toolSettings(agent.data), ...patch.tools };
  const hydrated = agent.primarySkillId ? await hydrateAgentSkill(orgId, agent) : agent;
  const current = roleplayBuilderFrom(hydrated.data);
  if (!current) throw new ScenarioIngestError(`Role play "${slug}" has no builder fields`, 400);
  const parsed = roleplayBuilderSchema.safeParse({ ...current, ...patch.builder, situation: { ...current.situation, ...patch.builder?.situation } });
  if (!parsed.success) throw new ScenarioIngestError(parsed.error.issues[0]?.message ?? "Invalid role play", 400);
  const saved = await saveRoleplay(orgId, parsed.data, slug, before, tools);
  return { slug: saved.slug, version: saved.version, changed: true };
}
