import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

const inputSchema = z.object({
  slug: z.string().min(1),
  builder: z.record(z.string(), z.unknown()).optional().describe(
    "Builder role plays only: the fields to change, named as get_roleplay returns them (name, clientName, situation {scenario, hiddenTruth, learnerRole, agreesWhen, declinesWhen}, difficulty, howTheyTalk, guardedIf, opensUpIf, whatToExpect, opening, exampleLines, learnerGoals, rubric). Omitted fields keep their value.",
  ),
  before: z.object({
    preScreenshare: z.boolean(), preUpload: z.boolean(), duringUpload: z.boolean(),
    uploadTitle: z.string().max(80), uploadInstruction: z.string().max(300),
  }).partial().optional(),
  tools: z.object({ canvas: z.boolean(), codeEditor: z.boolean(), preview: z.boolean(), choice: z.boolean() }).partial().optional()
    .describe("Workspace tools the client may open during the call."),
});

const describe = (input: z.infer<typeof inputSchema>) => [
  ...Object.entries(input.builder ?? {}).map(([key, value]) => `${key} → ${JSON.stringify(value).slice(0, 140)}`),
  ...Object.entries(input.before ?? {}).map(([key, value]) => `${key} → ${JSON.stringify(value)}`),
  ...Object.entries(input.tools ?? {}).map(([key, value]) => `tool ${key} → ${value ? "on" : "off"}`),
].join("; ");

export default defineTool({
  description:
    "Change a role play: builder fields (builder role plays only), Settings (before) and Tools. Only what you pass changes. Needs the trainer's approval; read it with get_roleplay first. A role play built from recordings changes its script through roleplay-creator, not here.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change role play "${input?.slug}": ${input ? describe(input) || "no fields" : ""}`,
  },
  async execute(input, ctx) {
    return studioResult(ctx, { action: "updateRoleplay", ...input });
  },
});
