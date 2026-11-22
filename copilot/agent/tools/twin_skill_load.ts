import { defineTool } from "eve/tools";
import { z } from "zod";
import { sessionIo } from "../lib/session-io";
import { studio } from "../lib/studio";
import { loadTwinBase, type TwinItem } from "../lib/twin-skill";

type Published = {
  slug: string; kind: string; name: string; version: number; currentVersion: number;
  versions: { version: number }[]; skill: string; manifest: unknown; items: TwinItem[]; patterns: string | null;
};

export default defineTool({
  description:
    "Twin skill update only (twin-creator): load a published twin skill as the starting point of an update. Writes its files into twin-skills/<id>/ and switches twin_skill_build to update mode (loaded items are kept; pass only new items, `remove` with reasons, and `edits`). Returns its situations, items, sources, body and patterns. `version` loads an older version, to restore it. Not for role plays (roleplay_recording_load, roleplay_read).",
  inputSchema: z.object({
    user: z.string().describe("The USER folder the skill builders use."),
    slug: z.string().min(1).describe("A twin-skill slug from twin_list."),
    version: z.number().int().positive().optional(),
  }),
  async execute({ user, slug, version }, ctx) {
    try {
      const published = await studio<Published>(ctx, { action: "getSkill", slug, ...(version ? { version } : {}) });
      if (published.kind !== "twin-skill" && published.kind !== "twin-skill-legacy") {
        return { error: `"${slug}" is a ${published.kind}, not a twin skill. ${published.kind === "roleplay-recordings" ? "Use roleplay_recording_load." : "Read it with twin_read or roleplay_read."}` };
      }
      const loaded = await loadTwinBase(await sessionIo(ctx), user, published);
      return {
        mode: "update",
        next: "Read the new material, then call twin_skill_build with the same skill id, the new items, `remove` for loaded items that no longer hold, and `edits` (find/replace on the loaded SKILL.md and patterns.md; never the whole texts). Show the changes to the trainer before twin_skill_publish.",
        currentVersion: published.currentVersion,
        ...loaded,
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
