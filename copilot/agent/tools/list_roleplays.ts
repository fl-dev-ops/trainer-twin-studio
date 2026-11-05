import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioResult } from "../lib/studio";

export default defineTool({
  description:
    "List the trainer's role plays (Scenarios): slug, name, kind (roleplay-builder: made in the builder; roleplay-recordings: built from recordings), skillId, version, description, archived. Use before reading, changing, rebuilding, inviting to or archiving a role play, so you use its exact slug. includeArchived also lists archived ones (to restore).",
  inputSchema: z.object({ includeArchived: z.boolean().optional() }),
  async execute({ includeArchived }, ctx) {
    return studioResult(ctx, { action: "list", kind: "roleplay", ...(includeArchived ? { includeArchived } : {}) });
  },
});
