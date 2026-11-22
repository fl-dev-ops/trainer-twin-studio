import { defineTool } from "eve/tools";
import { z } from "zod";
import { outPath } from "../lib/paths";
import { sessionIo } from "../lib/session-io";

export default defineTool({
  description:
    "Read a file this conversation produced under output/<user>/ (specs/<id>.md, report.md, plan.json, a build's SKILL.md or items.json, a loaded baseline). Read-only. Not for knowledge-base files (knowledge_read).",
  inputSchema: z.object({ user: z.string(), path: z.string().min(1).describe("Path inside output/<user>/, e.g. specs/renewal.md.") }).strict(),
  async execute({ user, path }, ctx) {
    const text = await (await sessionIo(ctx)).read(outPath(user, path));
    return text == null ? { path, missing: true } : { path, text };
  },
});
