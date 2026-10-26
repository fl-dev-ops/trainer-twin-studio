import { defineDynamic, defineInstructions } from "eve/instructions";
import BASE from "../../prompts/base-instructions.md?raw";
import { baseInstructions } from "../lib/base-instructions";
import { formatSessionSpec, loadSessionContext } from "../lib/brain";

/**
 * Base instructions plus per-session grounding: pulls scenario specs, persona traits, and attached
 * documents from the studio and injects them as system context for the session. Playbook and twin
 * sessions get only the core base instructions; everything else gets the whole file.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current;
      const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
      const orgId = attributes.orgId;
      const full = defineInstructions({ content: baseInstructions(BASE, false) });
      if (typeof orgId !== "string" || !orgId) return full;

      const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
      const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
      const personaSlug = typeof attributes.personaSlug === "string" ? attributes.personaSlug : undefined;
      const mode = (attributes.mode === "chat" ? "chat" : "voice") as "voice" | "chat";
      const clientTools = (attributes.clientTools ?? "").split(",").filter(Boolean);

      try {
        const specs = await loadSessionContext(orgId, sessionId, agentSlug, personaSlug, mode, clientTools);
        const base = baseInstructions(BASE, Boolean(specs.twin || specs.playbook));
        return defineInstructions({ content: `${base}\n\n${formatSessionSpec(specs)}` });
      } catch (err) {
        console.error("Failed to load session context for brain grounding:", err);
        return full;
      }
    },
  },
});
