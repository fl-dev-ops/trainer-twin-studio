import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges, proposedInput } from "../lib/changes";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("From bot_list."),
  persona: z.string().min(1).optional().describe("A persona slug from persona_list."),
  name: z.string().trim().min(1).max(120).optional(),
  objective: z.string().trim().min(1).max(2000).optional().describe("Its purpose."),
  skills: z.array(z.object({ slug: z.string().min(1), active: z.boolean() })).max(50).optional()
    .describe("The full ordered list of supporting skills (published twin skill slugs from twin_list), each on or off. Replaces the current list."),
  proposed: proposedInput,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as bot_read showed it; shown on the approval card."),
}).strict();

export default defineTool({
  description:
    "Change a bot's persona, name, purpose or supporting skills. Only what you pass changes; skills, when passed, is the whole ordered list. Needs the trainer's approval; read it with bot_read first. Public calls and widget websites are not changed here (the trainer does that under Bots).",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change bot "${input?.label ?? input?.slug}": ${describeChanges({
      persona: input?.persona, name: input?.name, objective: input?.objective,
      skills: input?.skills?.map((skill) => `${skill.slug}${skill.active ? "" : " (off)"}`).join(", "),
    }, undefined, input?.proposed) || "no fields"}`,
  },
  async execute({ slug, persona, name, objective, skills }, ctx) {
    return studioResult(ctx, {
      action: "updateBot", slug,
      ...(persona !== undefined ? { persona } : {}), ...(name !== undefined ? { name } : {}),
      ...(objective !== undefined ? { objective } : {}), ...(skills !== undefined ? { skills } : {}),
    });
  },
});
