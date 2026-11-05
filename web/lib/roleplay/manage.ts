import { type ToolSettings, toolSettings } from "@/lib/agent-tools";
import { type BeforeSettings, beforeSettings } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { type RoleplayBuilder, roleplayBuilderFrom, roleplayBuilderSchema } from "@/lib/roleplay/skill";
import { ROLEPLAY_SOURCE, saveRoleplay, ScenarioIngestError } from "@/lib/scenario-ingest";

/**
 * Changes a builder role play (copilot): any builder fields, Settings (Before) or Tools; missing ones keep their value.
 * Goes through saveRoleplay, so the script is re-rendered exactly as the builder page does and a real change is a new
 * version (the old one stays in SpecVersion and S3). Role plays built from recordings are changed by their skill
 * update instead (copilot roleplay-creator), and their Settings/Tools with `settings` only.
 */
export async function updateRoleplay(
  orgId: string,
  slug: string,
  patch: { builder?: Partial<RoleplayBuilder>; before?: Partial<BeforeSettings>; tools?: Partial<ToolSettings> },
) {
  const agent = await db.agent.findFirst({ where: { orgId, slug, kind: "ROLEPLAY", archivedAt: null }, select: { id: true, data: true } });
  if (!agent) throw new ScenarioIngestError(`Role play "${slug}" was not found`, 404);
  const before = { ...beforeSettings(agent.data), ...patch.before };
  const tools = { ...toolSettings(agent.data), ...patch.tools };
  const data = (agent.data && typeof agent.data === "object" ? agent.data : {}) as Record<string, unknown>;

  if (data.source !== ROLEPLAY_SOURCE) {
    if (patch.builder) throw new ScenarioIngestError("This role play was built from recordings: update its skill instead of builder fields", 400);
    await db.agent.update({ where: { id: agent.id }, data: { data: { ...data, before, tools } } });
    return { slug, changed: true };
  }

  const current = roleplayBuilderFrom(agent.data);
  if (!current) throw new ScenarioIngestError(`Role play "${slug}" has no builder fields`, 400);
  const parsed = roleplayBuilderSchema.safeParse({ ...current, ...patch.builder, situation: { ...current.situation, ...patch.builder?.situation } });
  if (!parsed.success) throw new ScenarioIngestError(parsed.error.issues[0]?.message ?? "Invalid role play", 400);
  const saved = await saveRoleplay(orgId, parsed.data, slug, before, tools);
  return { slug: saved.slug, version: saved.version, changed: true };
}
