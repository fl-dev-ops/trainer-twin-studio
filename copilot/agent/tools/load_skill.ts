import { defineTool } from "eve/tools";
import { z } from "zod";
import { outPath } from "../lib/paths";
import { sessionIo } from "../lib/session-io";
import { studio } from "../lib/studio";
import { loadTwinBase, type TwinItem } from "../lib/twin-skill";

type Published = {
  slug: string; kind: string; name: string; version: number; currentVersion: number;
  versions: { version: number }[]; skill: string; manifest: unknown; items: unknown[]; patterns: string | null;
};

export default defineTool({
  description:
    "Load a published twin skill or role play as the starting point of an update (never start an existing skill from scratch). Twin skill: writes its SKILL.md, skill.json, patterns.md and items into twin-skills/<id>/ and switches build_twin_skill to update mode: the loaded items are kept, you pass only new items and `remove` (each with a reason), and the skill id stays. Returns its situations, items (id, situation, kind, source, text), sources, body and patterns. Role play built from recordings: its files are written to baseline/<slug>/ for reference. version loads an older version (to restore it).",
  inputSchema: z.object({
    user: z.string().describe("The USER folder the skill builders use."),
    slug: z.string().min(1).describe("The slug from list_twins or list_roleplays."),
    version: z.number().int().positive().optional(),
  }),
  async execute({ user, slug, version }, ctx) {
    try {
      const published = await studio<Published>(ctx, { action: "getSkill", slug, ...(version ? { version } : {}) });
      const io = await sessionIo(ctx);
      if (published.kind === "twin-skill" || published.kind === "twin-skill-legacy") {
        const loaded = await loadTwinBase(io, user, { ...published, items: published.items as TwinItem[] });
        return {
          mode: "update",
          next: "Read the new material, then call build_twin_skill with the same skill id, the new items, `remove` for loaded items that no longer hold, and the revised body and patterns. Show the changes to the trainer before publish_twin_skill.",
          currentVersion: published.currentVersion,
          ...loaded,
        };
      }
      const dir = `baseline/${published.slug}`;
      await Promise.all([
        io.write(outPath(user, `${dir}/SKILL.md`), published.skill),
        io.write(outPath(user, `${dir}/manifest.json`), JSON.stringify(published.manifest, null, 2)),
        io.write(outPath(user, `${dir}/items.json`), JSON.stringify(published.items, null, 1)),
        ...(published.patterns ? [io.write(outPath(user, `${dir}/patterns.md`), published.patterns)] : []),
      ]);
      return {
        mode: "reference",
        kind: published.kind,
        version: published.version,
        folder: outPath(user, dir),
        note: published.kind === "roleplay-builder"
          ? "A builder role play: change its fields with update_roleplay, not by rebuilding."
          : "A role play built from recordings: rebuild it with roleplay-creator using the same scenario id and these files as the starting point; reuse its plan and items where they still hold.",
        items: published.items.length,
        manifest: published.manifest,
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
