import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "Archive a twin skill or role play (soft delete): it disappears from the studio, the twin and new sessions, and can be restored with restore_item. Its versions, files and past sessions stay. Never call it to delete anything else; there is no hard delete. Needs the trainer's approval.",
  inputSchema: z.object({ slug: z.string().min(1), name: z.string().min(1).describe("Its name, shown on the approval card.") }),
  approval: { request: always(), prompt: ({ input }) => `Archive "${input?.name}" (${input?.slug})? It can be restored later.` },
  async execute({ slug }, ctx) {
    return studioResult(ctx, { action: "archive", slug });
  },
});
