import { defineTool } from "eve/tools";
import { z } from "zod";
import { executeWorkspaceTool } from "../lib/workspace-tools";

export default defineTool({
  description: "Validate one new resume main question against an eligible claim ID and wait for its exact stored anchor to be highlighted in the learner's PDF. Speak the submitted question only when result.status is highlighted. On not_found ask the learner to locate the claim; on viewer_unavailable or document_mismatch wait for recovery. Never use this for follow-ups.",
  inputSchema: z.object({
    claimId: z.string().trim().min(1),
    question: z.string().trim().min(1).max(500),
  }),
  async execute(input, ctx) {
    const response = await executeWorkspaceTool(input, ctx) as {
      status?: string;
      result?: { status?: string };
    };
    return { status: response.result?.status ?? response.status ?? "viewer_unavailable" };
  },
});
