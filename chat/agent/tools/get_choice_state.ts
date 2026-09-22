import { z } from "zod";
import { defineTool } from "eve/tools";
import { activeMcqState, gradeMcqSelection } from "../lib/mcq-state";
import { executeWorkspaceTool } from "../lib/workspace-tools";

export default defineTool({
  description: "Get the on-screen MCQ and server-computed isCorrect result. MUST call before evaluating a selected answer. Trust isCorrect; never infer correctness from the learner's explanation or option wording.",
  inputSchema: z.object({}),
  async execute(input, ctx) {
    const response: any = await executeWorkspaceTool(input, ctx);
    const choice = response?.result?.result;
    const active = activeMcqState.get();
    const isCorrect = gradeMcqSelection(active, choice?.questionId, choice?.selectedId);
    return {
      ...response,
      result: {
        ...response?.result,
        result: { ...choice, isCorrect },
      },
    };
  },
});
