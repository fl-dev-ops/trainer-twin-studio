import { defineDynamic, defineSkill } from "eve/skills";
import { type AgentKind, type TwinPlaybook, inlineTwinPlaybooks, playbookSkillNames, twinSessionPlaybooks } from "../lib/brain";
import { studioFetch } from "../lib/studio";

/**
 * Twin sessions get one skill per playbook: every skill of the persona for "Ask Olga", the skill itself for a single
 * twin-creator skill. The skill is the ingested SKILL.md.
 * eve lists only each skill's description; the model loads a playbook with eve__skill when a
 * question needs it, so the prompt never carries every playbook. Other sessions get none, and neither do small twins,
 * whose playbooks are all in the prompt (inlineTwinPlaybooks).
 */
export default defineDynamic(async (ctx) => {
  const attributes = (ctx.session.auth.current?.attributes ?? {}) as Record<string, string | undefined>;
  const orgId = attributes.orgId;
  if (!orgId || (!attributes.sessionId && !attributes.agentSlug)) return null;

  // Once per session (eve runs this before every model call): the playbooks to offer as skills, as JSON.
  const skills = await ctx.memo(["playbooks", ctx.session.id], async () => {
    // Same call as the session-spec instructions; web caches it per session.
    const context = await studioFetch<{
      agent: { slug?: string; kind?: AgentKind | null; data?: Record<string, unknown> } | null;
      twinPlaybooks?: TwinPlaybook[];
    }>(orgId, {
      action: "getSessionContext",
      sessionId: attributes.sessionId,
      agentSlug: attributes.agentSlug,
      personaSlug: attributes.personaSlug,
    });
    const playbooks = twinSessionPlaybooks(context.agent, context.twinPlaybooks) ?? [];
    // A small twin has every playbook in its prompt already (formatTwinSession); skills would only invite a load call.
    if (playbooks.length === 0 || inlineTwinPlaybooks(playbooks)) return [];
    const names = playbookSkillNames(playbooks);
    return playbooks.map((playbook, i) => ({
      name: names[i],
      description: `${playbook.name}${playbook.description ? `: ${playbook.description}` : ""} Load before advising on a real situation of this kind.`.slice(0, 1024),
      content: playbook.skill,
    }));
  });
  if (skills.length === 0) return null;
  return Object.fromEntries(skills.map((skill) => [skill.name, defineSkill({ description: skill.description, content: skill.content })]));
});
