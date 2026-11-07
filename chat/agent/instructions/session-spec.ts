import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadSessionContext } from "../lib/brain";
import { composeInstructions, FALLBACK_INSTRUCTIONS } from "../lib/compose-instructions";
import { twinLinesState } from "../lib/plan-state";
import { sessionMode } from "../lib/session-mode";
import { primeSessionMode } from "../lib/session-mode-lookup";
import { studioFetch } from "../lib/studio";

/**
 * The session's instructions (lib/compose-instructions.ts): the platform rules, the session mode's operating
 * instructions and its grounding (scenario specs, persona traits, attached documents) from the studio.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current;
      const attributes = (auth?.attributes ?? {}) as Record<string, string | undefined>;
      const orgId = attributes.orgId;
      const fallback = defineInstructions({ content: FALLBACK_INSTRUCTIONS });
      if (typeof orgId !== "string" || !orgId) return fallback;

      const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
      const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
      const personaSlug = typeof attributes.personaSlug === "string" ? attributes.personaSlug : undefined;
      const mode = (attributes.mode === "chat" ? "chat" : "voice") as "voice" | "chat";
      const clientTools = (attributes.clientTools ?? "").split(",").filter(Boolean);

      try {
        const specs = await loadSessionContext(orgId, sessionId, agentSlug, personaSlug, mode, clientTools);
        // The channel and tools ask for the mode later; answer from the context already loaded.
        primeSessionMode(orgId, sessionId, agentSlug, sessionMode(specs));
        // A small twin gets its lines per turn instead of searching for them (agent/instructions/twin-lines.ts).
        if (specs.twin?.inline) {
          twinLinesState.update(() => ({
            agentSlug: specs.agentSlug,
            personaName: specs.personaName ?? specs.personaSlug ?? "the trainer",
            playbooks: specs.twin!.inline!,
          }));
          // Warm the lookup path (vector store connection, embeddings) during the countdown, so the first learner
          // turn's lines don't hit a cold start. Best effort.
          void studioFetch(orgId, { action: "searchScenarioItems", agentSlug: specs.agentSlug, query: "warm up", role: "trainer", limit: 1, sessionId })
            .catch(() => {});
        }
        return defineInstructions({ content: composeInstructions(specs) });
      } catch (err) {
        console.error("Failed to load session context for brain grounding:", err);
        return fallback;
      }
    },
  },
});
