import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1).describe("The main twin's slug from twin_list (kind main-twin)."),
  skills: z.array(z.object({ slug: z.string().min(1), active: z.boolean() })).max(50)
    .describe("The full ordered list of its supporting skills (twin skill slugs), each on or off. Replaces the current list."),
  label: z.string().trim().min(1).max(200).optional().describe("Its current name, shown on the approval card."),
}).strict();

export default defineTool({
  description:
    "Choose which topic skills the main twin draws on, in order, each on or off (an off skill stays attached but is left out of new calls). Replaces the whole list; an empty list means it uses every topic skill again. Needs the trainer's approval; read the twin with twin_read first.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Set "${input?.label ?? input?.slug}" skills: ${input?.skills?.map((skill, index) => `${index + 1}. ${skill.slug}${skill.active ? "" : " (off)"}`).join(", ") || "all topic skills"}`,
  },
  async execute({ slug, skills }, ctx) {
    return studioResult(ctx, { action: "setTwinSkills", slug, skills });
  },
});
