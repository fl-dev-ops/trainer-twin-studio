import { defineTool } from "eve/tools";
import { specDraftBundleSchema } from "../lib/spec-draft-schema";
import { designState } from "../lib/design-state";
import { callStudio } from "../lib/studio";

export default defineTool({
  description: "Create or overwrite a canonical TrainerTwin Agent and Domain working draft. Saved drafts appear immediately in the app's Agents library but remain non-runnable until publication. Use this instead of pasting full specs into chat; every changed save preserves the previous revision.",
  inputSchema: specDraftBundleSchema,
  async execute(bundle, ctx) {
    const saved = await callStudio<{ slug: string; name: string; status: string; revision: number; changed: boolean }>(
      { action: "saveDraft", bundle },
      ctx.abortSignal,
    );
    designState.update(() => ({ draftSlug: saved.slug }));
    return { ...saved, libraryPath: `/agents/${saved.slug}` };
  },
});
