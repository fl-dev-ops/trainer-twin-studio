import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

const settings = z.object({
  preScreenshare: z.boolean().describe("Learners share their screen for the whole call."),
  preUpload: z.boolean().describe("Learners may add a file before the call."),
  duringUpload: z.boolean().describe("Learners may attach an image during the call."),
  uploadTitle: z.string().max(80),
  uploadInstruction: z.string().max(300),
}).partial();
const inputSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  settings: settings.optional(),
});

const describe = (input: z.infer<typeof inputSchema>) => [
  input.name !== undefined ? `name → "${input.name}"` : null,
  input.description !== undefined ? `description → "${input.description.slice(0, 160)}${input.description.length > 160 ? "…" : ""}"` : null,
  ...Object.entries(input.settings ?? {}).map(([key, value]) => `${key} → ${JSON.stringify(value)}`),
].filter(Boolean).join("; ");

export default defineTool({
  description:
    "Change a twin or twin skill: name, description and Before settings (only the fields you pass). Needs the trainer's approval; read it with get_twin first. A real change is a new version; the old one is kept.",
  inputSchema,
  approval: {
    request: always(),
    prompt: ({ input }) => `Change twin "${input?.slug}": ${input ? describe(input) || "no fields" : ""}`,
  },
  async execute(input, ctx) {
    return studioResult(ctx, { action: "updateTwin", ...input });
  },
});
