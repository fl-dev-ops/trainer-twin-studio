import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Read one twin or twin skill by slug (from list_twins): name, description, Before settings, version, and its learners (email, status, minutes). Read it before proposing a change, so the change shows what it was.",
  inputSchema: z.object({ slug: z.string().min(1) }),
  async execute({ slug }, ctx) {
    return studioResult(ctx, { action: "get", slug, kind: "twin" });
  },
});
