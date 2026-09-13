import { defineDynamic, defineInstructions } from "eve/instructions";
import { formatSessionSpec, loadSessionContext } from "../lib/brain";

/**
 * Per-session grounding: pulls scenario specs, persona traits, and attached
 * documents from the studio and injects them as system context for the session.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current;
      const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
      const orgId = attributes.orgId;
      if (typeof orgId !== "string" || !orgId) return null;

      const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
      const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
      const personaSlug = typeof attributes.personaSlug === "string" ? attributes.personaSlug : undefined;
      const mode = (attributes.mode === "chat" ? "chat" : "voice") as "voice" | "chat";

      try {
        const specs = await loadSessionContext(orgId, sessionId, agentSlug, personaSlug, mode);
        return defineInstructions({ content: formatSessionSpec(specs) });
      } catch (err) {
        console.error("Failed to load session context for brain grounding:", err);
        return null;
      }
    },
  },
});
