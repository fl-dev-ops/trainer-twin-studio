import { z } from "zod";
import { transportTool } from "../workspace-tools";

/**
 * Slide tools (the browser's presentation viewer). Not offered: there is no Tools switch for slides yet, so nothing
 * loads these. To offer them, add a switch (lib/agent-tools.ts) and return them from tools/workspace.ts.
 */
export const presentationTools = {
  get_presentation_state: transportTool("Get current presentation slide number, total slides, and viewer state.", z.object({})),
  set_presentation_slide: transportTool("Navigate to a specific slide in the presentation (0-indexed).", z.object({ slide_index: z.number().int().min(0) })),
  next_presentation_slide: transportTool("Advance to the next slide in the presentation.", z.object({})),
  previous_presentation_slide: transportTool("Return to the previous slide in the presentation.", z.object({})),
};
