import { z } from "zod";
import { transportTool } from "../workspace-tools";

/**
 * Presentation navigation, enabled by the same Preview switch as PDF/image surfaces.
 */
export const presentationTools = {
  get_presentation_state: transportTool("Get current presentation slide number, total slides, and viewer state.", z.object({})),
  set_presentation_slide: transportTool("Navigate to a specific slide in the presentation (0-indexed).", z.object({ slide_index: z.number().int().min(0) })),
  next_presentation_slide: transportTool("Advance to the next slide in the presentation.", z.object({})),
  previous_presentation_slide: transportTool("Return to the previous slide in the presentation.", z.object({})),
};
