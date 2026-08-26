import { defineTool } from "eve/tools";
import { z } from "zod";
import { callStudio } from "../lib/studio";

const inputSchema = z.object({
  type: z.enum(["persona", "agent", "domain"]),
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
});

export default defineTool({
  description: "Read one current TrainerTwin Persona, Agent, or Domain specification by slug.",
  inputSchema,
  execute(input, ctx) {
    return callStudio<Record<string, unknown>>({ action: "readSpec", ...input }, ctx.abortSignal);
  },
});
