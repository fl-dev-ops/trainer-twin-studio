import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Read one twin, twin skill or role play by slug: name, description, Before settings, version, its learners (email, status, minutes) and, for role plays, Tools and the builder fields. Read it before proposing a change so the change shows what it was.",
  inputSchema: z.object({ slug: z.string().min(1) }),
  async execute({ slug }, ctx) {
    return studioResult(ctx, { action: "get", slug });
  },
});
