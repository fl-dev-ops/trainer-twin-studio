import { defineTool } from "eve/tools";
import { z } from "zod";
import { outPath } from "../lib/paths";
import { sessionIo } from "../lib/session-io";
import { studio } from "../lib/studio";

type Published = { slug: string; kind: string; version: number; skill: string; manifest: unknown; items: unknown[]; patterns: string | null };

export default defineTool({
  description:
    "Role play from recordings update only (roleplay-creator): load a published recordings role play into baseline/<slug>/ (SKILL.md, manifest.json, items.json, patterns.md) as the starting point of a rebuild with the same scenario id. `version` loads an older version. Not for builder or brief role plays (roleplay_read) or twin skills (twin_skill_load).",
  inputSchema: z.object({
    user: z.string().describe("The USER folder the skill builders use."),
    slug: z.string().min(1).describe("A roleplay-recordings slug from roleplay_list."),
    version: z.number().int().positive().optional(),
  }),
  async execute({ user, slug, version }, ctx) {
    try {
      const published = await studio<Published>(ctx, { action: "getSkill", slug, ...(version ? { version } : {}) });
      if (published.kind !== "roleplay-recordings") {
        return { error: `"${slug}" is a ${published.kind}, not a role play built from recordings. ${published.kind.startsWith("twin") ? "Use twin_skill_load." : "Read it with roleplay_read and change it there."}` };
      }
      const io = await sessionIo(ctx);
      const dir = `baseline/${published.slug}`;
      await Promise.all([
        io.write(outPath(user, `${dir}/SKILL.md`), published.skill),
        io.write(outPath(user, `${dir}/manifest.json`), JSON.stringify(published.manifest, null, 2)),
        io.write(outPath(user, `${dir}/items.json`), JSON.stringify(published.items, null, 1)),
        ...(published.patterns ? [io.write(outPath(user, `${dir}/patterns.md`), published.patterns)] : []),
      ]);
      return {
        version: published.version,
        folder: outPath(user, dir),
        next: "Rebuild with roleplay_recording_build using the same scenario id, reusing its plan and items where they still hold; read these files with note_read.",
        items: published.items.length,
        manifest: published.manifest,
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
