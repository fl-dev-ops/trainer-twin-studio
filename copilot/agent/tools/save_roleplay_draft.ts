import { defineTool } from "eve/tools";
import { z } from "zod";
import { designState } from "../lib/design-state";
import { roleplayInputSchema } from "../lib/roleplay-schema";
import { callStudio } from "../lib/studio";

export default defineTool({
  description: "Create or overwrite a role-play working draft (sales organizations only). The Studio builds the runnable spec from these fields. Saved drafts appear in the app's Role plays library but are not runnable until published.",
  inputSchema: z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).describe("Stable id, e.g. wait-and-see-investor."),
    roleplay: roleplayInputSchema,
  }),
  async execute({ slug, roleplay }, ctx) {
    const saved = await callStudio<{ slug: string; name: string; status: string; revision: number; changed: boolean }>(
      { action: "saveRoleplayDraft", slug, input: roleplay },
      ctx,
    );
    designState.update(() => ({ draftSlug: saved.slug }));
    return { ...saved, libraryPath: `/agents/${saved.slug}` };
  },
});
