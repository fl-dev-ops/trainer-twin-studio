import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { designState } from "../lib/design-state";
import { callStudio } from "../lib/studio";

export default defineTool({
  description: "Publish a validated TrainerTwin draft as immutable Agent and Domain versions. Call only after the user explicitly asks to publish.",
  inputSchema: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional() }),
  approval: always(),
  async execute({ slug }, ctx) {
    const selected = slug ?? designState.get().draftSlug;
    if (!selected) throw new Error("No draft is active in this conversation");
    return callStudio<Record<string, unknown>>({ action: "publishDraft", slug: selected }, ctx.abortSignal);
  },
});
