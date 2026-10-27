import { defineDynamic, defineSkill } from "eve/skills";
import { type AgentKind, type TwinPlaybook, playbookSkillNames, twinSessionPlaybooks } from "../lib/brain";
import { studioFetch } from "../lib/studio";

/**
 * Twin sessions get one skill per playbook: every skill of the persona for "Ask Olga", the skill itself for a single
 * twin-creator skill. The skill is the ingested SKILL.md.
 * eve lists only each skill's description; the model loads a playbook with eve__skill when a
 * question needs it, so the prompt never carries every playbook. Other sessions get none.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const attributes = (ctx.session.auth.current?.attributes ?? {}) as Record<string, string | undefined>;
      const orgId = attributes.orgId;
      if (!orgId || (!attributes.sessionId && !attributes.agentSlug)) return null;

      // Same call as the session-spec instructions; web caches it per session.
      const context = await studioFetch<{ agent: { slug?: string; kind?: AgentKind | null; data?: Record<string, unknown> } | null; twinPlaybooks?: TwinPlaybook[] }>(orgId, {
        action: "getSessionContext",
        sessionId: attributes.sessionId,
        agentSlug: attributes.agentSlug,
        personaSlug: attributes.personaSlug,
      });
      const playbooks = twinSessionPlaybooks(context.agent, context.twinPlaybooks) ?? [];
      if (playbooks.length === 0) return null;

      const names = playbookSkillNames(playbooks);
      return Object.fromEntries(
        playbooks.map((playbook, i) => [
          names[i],
          defineSkill({
            description: `${playbook.name}${playbook.description ? `: ${playbook.description}` : ""} Load before advising on a real situation of this kind.`.slice(0, 1024),
            markdown: playbook.skill,
          }),
        ]),
      );
    },
  },
});
