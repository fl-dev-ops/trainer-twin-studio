import { defineDynamic, defineInstructions } from "eve/instructions";
import { formatSessionSpec, loadSessionSpecs } from "../lib/brain";

/**
 * Per-session grounding: pulls the scenario (agent) and trainer (persona) specs
 * from the studio and injects them as system context. The auth attributes
 * (orgId, agentSlug, personaSlug) are attached by the calling channel.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current;
      const attributes = auth?.attributes ?? {};
      const orgId = attributes.orgId;
      const agentSlug = attributes.agentSlug;
      if (typeof orgId !== "string" || typeof agentSlug !== "string") return null;
      const personaSlug = typeof attributes.personaSlug === "string" ? attributes.personaSlug : undefined;

      try {
        const specs = await loadSessionSpecs(orgId, agentSlug, personaSlug);
        return defineInstructions({ content: formatSessionSpec(specs, agentSlug) });
      } catch {
        // Grounding failure must not kill the session; the core instructions still hold.
        return null;
      }
    },
  },
});
