// Write tool scoped to the one file kind an agent owns, so each agent can only produce its own output.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { outPath, userId, writeOut } from "./paths";
import { sessionIo } from "./session-io";

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function relPath(user: string, path: string, owns: RegExp, label: string) {
  const id = userId(user);
  // Models often repeat the user folder; strip it so files never land in output/<user>/<user>/.
  const rel = path.trim().replace(/^\/+/, "").replace(new RegExp(`^(output/)?${id}/`), "");
  if (!owns.test(rel)) throw new Error(`you may only write ${label}; got ${path}`);
  return { id, rel };
}

export function writeTool(owns: RegExp, label: string) {
  return defineTool({
    description: `Write ${label} under output/<user>/, replacing it. JSON must be valid. To change part of an existing file, use edit if you have it.`,
    inputSchema: z.object({ user: z.string(), path: z.string(), content: z.string() }),
    async execute({ user, path, content }, ctx) {
      const { id, rel } = relPath(user, path, owns, label);
      if (rel.endsWith(".json")) JSON.parse(content);
      return { ...(await writeOut(await sessionIo(ctx), id, rel, content)), words: words(content) };
    },
  });
}
