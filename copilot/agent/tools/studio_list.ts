import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the organization's twins, twin skills and role plays: slug, name, kind (main-twin, twin-skill, roleplay-builder, roleplay-recordings), skillId, version, archived. Call before changing, updating, inviting to or archiving one, so you use its exact slug. includeArchived also lists archived ones (to restore).",
  inputSchema: z.object({ includeArchived: z.boolean().optional() }),
  async execute({ includeArchived }, ctx) {
    return studioResult(ctx, { action: "list", ...(includeArchived ? { includeArchived } : {}) });
  },
});
