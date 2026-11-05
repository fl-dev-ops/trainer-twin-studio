import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description: "Restore an archived twin skill or role play (find it with studio_list includeArchived). Needs the trainer's approval.",
  inputSchema: z.object({ slug: z.string().min(1), name: z.string().min(1).describe("Its name, shown on the approval card.") }),
  approval: { request: always(), prompt: ({ input }) => `Restore "${input?.name}" (${input?.slug})?` },
  async execute({ slug }, ctx) {
    return studioResult(ctx, { action: "restore", slug });
  },
});
