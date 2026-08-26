import { defineTool } from "eve/tools";
import { z } from "zod";
import { designState } from "../lib/design-state";
import { callStudio } from "../lib/studio";

export default defineTool({
  description: "Read a working draft and its revision history. Omit slug to read the draft active in this conversation.",
  inputSchema: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional() }),
  async execute({ slug }, ctx) {
    const selected = slug ?? designState.get().draftSlug;
    if (!selected) return { error: "No draft is active in this conversation" };
    const draft = await callStudio<Record<string, unknown> | null>({ action: "readDraft", slug: selected }, ctx.abortSignal);
    if (draft && !("error" in draft)) designState.update(() => ({ draftSlug: selected }));
    return draft;
  },
});
