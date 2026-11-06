import { defineDynamic, defineInstructions } from "eve/instructions";
import BASE from "../../prompts/base-instructions.md?raw";
import { baseInstructions } from "../lib/base-instructions";
import { formatSessionSpec, loadSessionContext } from "../lib/brain";
import { twinLinesState } from "../lib/plan-state";
import { studioFetch } from "../lib/studio";

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
        const base = baseInstructions(BASE, Boolean(specs.twin || specs.playbook || specs.roleplay));
        return defineInstructions({ content: `${base}\n\n${formatSessionSpec(specs)}` });
      } catch (err) {
        console.error("Failed to load session context for brain grounding:", err);
        return full;
      }
    },
  },
});
