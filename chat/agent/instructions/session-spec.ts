import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadSessionContext } from "../lib/brain";
import { composeInstructions, FALLBACK_INSTRUCTIONS } from "../lib/compose-instructions";
import { sessionMode } from "../lib/session-mode";
import { primeSessionMode } from "../lib/session-mode-lookup";

/**
 * The session's instructions (lib/compose-instructions.ts): the platform rules, the session mode's operating
 * instructions and its grounding (scenario specs, persona traits, attached documents) from the studio.
 * eve runs this before every model call; the memo keeps the text fixed for the session (and across processes).
 */
export default defineDynamic(async (ctx) => {
  const auth = ctx.session.auth.current;
  const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
  const orgId = attributes.orgId;
  if (typeof orgId !== "string" || !orgId) return defineInstructions({ content: FALLBACK_INSTRUCTIONS });

  const content = await ctx.memo(["session-spec", ctx.session.id], async () => {
    const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
    const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
    const personaSlug = typeof attributes.personaSlug === "string" ? attributes.personaSlug : undefined;
    const mode = (attributes.mode === "chat" ? "chat" : "voice") as "voice" | "chat";
    const clientTools = (attributes.clientTools ?? "").split(",").filter(Boolean);
    try {
      const specs = await loadSessionContext(orgId, sessionId, agentSlug, personaSlug, mode, clientTools);
      // The channel and tools ask for the mode later; answer from the context already loaded.
      primeSessionMode(orgId, sessionId, agentSlug, sessionMode(specs));
      return composeInstructions(specs);
    } catch (err) {
      console.error("Failed to load session context for brain grounding:", err);
      return FALLBACK_INSTRUCTIONS;
    }
  });
  return defineInstructions({ content });
});
