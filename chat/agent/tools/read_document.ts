import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioFetch } from "../lib/studio";

export default defineTool({
  description:
    "Read or search sections from an attached candidate document or resume (e.g. past companies, project dates, specific tech stacks, or quantified achievements). Call this on-demand when the candidate mentions a specific project, timeframe, or system from their resume that you need exact details on.",
  inputSchema: z.object({
    documentId: z.string().trim().min(1).describe("The ID of the document to read from SESSION SPEC"),
    query: z.string().trim().optional().describe("Keywords or topic to search for, e.g. 'startup 2017 to 2019' or 'payments indexing'"),
    section: z.string().trim().optional().describe("Section heading if known, e.g. 'EXPERIENCE', 'TECHNICAL SKILLS', 'EDUCATION'"),
  }),
  async execute(input, ctx) {
    const orgId = ctx.session.auth.initiator?.principalId ?? ctx.session.auth.current?.principalId;
    if (!orgId) throw new Error("No organization attached to session");
    return studioFetch(orgId, {
      action: "readDocument",
      documentId: input.documentId,
      query: input.query,
      section: input.section,
    });
  },
});
