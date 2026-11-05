import { defineDynamic, defineInstructions } from "eve/instructions";
import { studio } from "../lib/studio";

type StudioContext = { org: string; trainer: string; personas: { slug: string; name: string }[] };

/**
 * Who this studio session works for: the org and its trainers' own personas. The skill tools take `user` (the sandbox
 * folder) and `persona` (who the twin or role play speaks as); both are the trainer's persona slug, so the trainer never
 * has to type a USER line. Sessions outside the studio (eve dev, TUI) get nothing here.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      if (ctx.session.auth.current?.principalType !== "organization") return null;
      let context: StudioContext;
      try {
        context = await studio<StudioContext>(ctx as never, { action: "context" });
      } catch (error) {
        console.warn("[copilot] studio context unavailable", (error as Error).message);
        return null;
      }
      const [first] = context.personas;
      const lines = [
        `STUDIO SESSION: organization "${context.org}", signed-in trainer ${context.trainer}.`,
        first
          ? `For every tool that takes \`user\` or \`persona\`, use "${first.slug}" (${first.name}'s persona) unless the trainer names another of: ${context.personas.map((p) => `"${p.slug}"`).join(", ")}. Never ask the trainer for a USER value.`
          : "This organization has no trainer persona yet: building or publishing a twin skill or role play needs one. Ask the trainer to set up their twin first.",
      ];
      return defineInstructions({ content: lines.join("\n") });
    },
  },
});
