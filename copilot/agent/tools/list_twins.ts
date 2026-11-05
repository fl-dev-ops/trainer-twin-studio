import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the trainer's twins: the main twin and its twin skills (slug, name, kind main-twin or twin-skill, skillId, version, description, archived). Use before reading, changing, updating, inviting to or archiving a twin or twin skill, so you use its exact slug. includeArchived also lists archived ones (to restore).",
  inputSchema: z.object({ includeArchived: z.boolean().optional() }),
  async execute({ includeArchived }, ctx) {
    return studioResult(ctx, { action: "list", kind: "twin", ...(includeArchived ? { includeArchived } : {}) });
  },
});
