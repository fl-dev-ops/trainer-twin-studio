import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { describeChanges } from "../lib/changes";
import { studioResult } from "../lib/studio";

const tools = z.object({
  canvas: z.boolean().describe("A whiteboard the client can draw on."),
  codeEditor: z.boolean().describe("A shared code editor."),
  preview: z.boolean().describe("A PDF viewer for uploaded documents; useful only with an upload in Settings."),
  choice: z.boolean().describe("Multiple-choice questions."),
  knowledge: z.boolean().describe("The client may search the knowledge base during the call."),
}).partial().strict();

export default defineTool({
  description:
    "Switch a role play's workspace tools on or off (canvas, code editor, PDF viewer, multiple choice, knowledge search). Only the tools you pass change. Needs the trainer's approval; read it with roleplay_read first. Not for Settings (roleplay_settings_update) or the script.",
  inputSchema: z.object({ slug: z.string().min(1).describe("From roleplay_list."), tools,
  label: z.string().trim().min(1).max(200).optional().describe("Its current name as twin_read/roleplay_read/persona_list showed it; shown on the approval card instead of the slug."),
  }).strict(),
  approval: {
    request: always(),
    prompt: ({ input }) => `Change role play "${input?.label ?? input?.slug}": ${describeChanges(input?.tools, (key) => `tool ${key}`) || "no fields"}`,
  },
  async execute({ slug, tools }, ctx) {
    return studioResult(ctx, { action: "updateRoleplay", slug, tools });
  },
});
