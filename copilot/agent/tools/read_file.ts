import { defineTool } from "eve/tools";
import readFile from "eve/tools/read_file";
import { z } from "zod";

export default defineTool({
  description: "Read a text attachment from this conversation using its displayed .eve/attachments path. For knowledge-base files use read.",
  inputSchema: z.object({
    filePath: z.string().regex(/^(?:\/workspace\/)?\.eve\/attachments\/[a-f0-9]+\/[^/\\\x00-\x1f]+\.md$/i),
    limit: z.number().int().positive().max(300).optional(),
    offset: z.number().int().nonnegative().optional(),
  }).strict(),
  async execute(input, ctx) {
    if (!readFile.execute) throw new Error("Attachment reader unavailable");
    return readFile.execute(input, ctx);
  },
});
