import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { anyToolOn, sessionToolSettings, type ToolSettings } from "../lib/agent-tools";
import { activeMcqState, gradeMcqSelection, prepareMcqPayload } from "../lib/mcq-state";
import { executeWorkspaceTool } from "../lib/workspace-tools";

/*
 * The workspace tools this session's agent may use (Agent.data.tools, the role play's Tools tab), resolved once when the
 * session starts: a switched-off surface's tools are not in the model's tool list at all. Tool names and behaviour are
 * the same as the static tools they replace. Slide tools stay in lib/workspace/presentation-tools.ts, not offered yet.
 *
 * eve rebuilds these after a recovery, so every callback is a module-level function and every schema a module-level
 * constant (no values captured from the resolver).
 */

// ---- Schemas (module-level so eve can rebuild them) ----
const noInput = z.object({});
const canvasComponentInput = z.object({ label: z.string().trim().min(1).max(200), x: z.number().int().default(100), y: z.number().int().default(100) });
const canvasElementInput = z.object({ element_id: z.string().trim().min(1).max(200) });
const whiteboardLabelInput = z.object({ component_label: z.string().trim().min(1) });
const lineRangeInput = z.object({ from_line: z.number().int().min(1), to_line: z.number().int().min(1) });
const choiceOptionInput = z.object({ option_id: z.string().trim().min(1).max(40) });
const surfaceInput = z.object({ action: z.string().trim().min(1).max(60), payload: z.record(z.string(), z.unknown()).optional() });
const workspaceRequestInput = z.object({
  method: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// ---- Executors with their own logic (module-level so eve can rebind them) ----

/** Opens or changes the learner-visible workspace; an MCQ keeps its answer key server-side. */
async function runSurface(input: z.infer<typeof surfaceInput>, ctx: unknown) {
  if (input.action === "open_choice") {
    const { active, publicPayload } = prepareMcqPayload(input.payload ?? {});
    activeMcqState.update(() => active);
    return executeWorkspaceTool({ ...input, payload: publicPayload }, ctx);
  }
  activeMcqState.update(() => null);
  return executeWorkspaceTool(input, ctx);
}

/** The on-screen MCQ with the server-computed isCorrect. */
async function getChoiceState(input: z.infer<typeof noInput>, ctx: unknown) {
  const response: any = await executeWorkspaceTool(input, ctx);
  const choice = response?.result?.result;
  const isCorrect = gradeMcqSelection(activeMcqState.get(), choice?.questionId, choice?.selectedId);
  return { ...response, result: { ...response?.result, result: { ...choice, isCorrect } } };
}

/** The surface tool's description: only the actions this session's switches allow. */
function surfaceDescription(tools: ToolSettings): string {
  const actions = [
    tools.canvas && "open_whiteboard",
    tools.codeEditor && "open_code_editor (payload { questionId, question, language, starterCode, readOnly })",
    tools.choice && "open_choice (payload { questionId, question, options: [{ id, text }], correctOptionId, code? })",
    tools.preview &&
      "open_pdf (payload { fileId }) for an attached PDF, highlight_document (payload { fileId, highlightQuery }) to search for a phrase. Resume interviews must use start_resume_question with a claim ID for highlights, never highlight_document or a free-form query",
    "close_surface",
  ].filter(Boolean);
  return `Open or change the learner-visible workspace. Actions available in this conversation: ${actions.join("; ")}. For documents, pass a SESSION DATA fileId; never invent IDs.`;
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const tools = await sessionToolSettings(ctx);
      if (!anyToolOn(tools)) return null;
      return {
        surface: defineTool({ description: surfaceDescription(tools), inputSchema: surfaceInput, execute: runSurface }),
        workspace_request: defineTool({
          description: "Request an action or state from the browser workspace over RPC.",
          inputSchema: workspaceRequestInput,
          execute: executeWorkspaceTool,
        }),
        ...(tools.canvas && {
          add_canvas_component: defineTool({
            description: "Add a system architecture component box with a label to the whiteboard canvas.",
            inputSchema: canvasComponentInput,
            execute: executeWorkspaceTool,
          }),
          clear_canvas: defineTool({ description: "Clear all elements from the whiteboard canvas.", inputSchema: noInput, execute: executeWorkspaceTool }),
          highlight_canvas_element: defineTool({
            description: "Highlight and scroll to a specific component element on the whiteboard canvas by ID.",
            inputSchema: canvasElementInput,
            execute: executeWorkspaceTool,
          }),
          highlight_whiteboard: defineTool({
            description:
              "Highlight one exact visible component label on the candidate's whiteboard, then ask one targeted follow-up about that component's responsibility, connection, bottleneck, failure mode, scale, or trade-off. Only call when the whiteboard diagram is relevant to the active system-design question. Never call to highlight components of an off-topic or irrelevant diagram. The label must match text the candidate actually wrote on the whiteboard; never invent a label.",
            inputSchema: whiteboardLabelInput,
            execute: executeWorkspaceTool,
          }),
          read_canvas_scene: defineTool({
            description:
              "Retrieve all elements and diagrams currently drawn on the whiteboard canvas. MUST call when the candidate says they have drawn, sketched, or updated the whiteboard ('I have drawn', 'Check my diagram', 'Here is my architecture'), or before asking follow-ups about their design.",
            inputSchema: noInput,
            execute: executeWorkspaceTool,
          }),
        }),
        ...(tools.codeEditor && {
          get_code_state: defineTool({
            description: "Get the full code, active programming language, and cursor selection in the editor.",
            inputSchema: noInput,
            execute: executeWorkspaceTool,
          }),
          read_code_range: defineTool({
            description:
              "Required before replying when a candidate is unsure, stuck, does not know, or requests help about an active Coding, Machine coding, or Code output editor, or after an incorrect or unexplained code-output run. Read inclusive one-based lines 1 through 200 and never read the returned code aloud.",
            inputSchema: lineRangeInput,
            execute: executeWorkspaceTool,
          }),
          highlight_code: defineTool({
            description:
              "Use after read_code_range. Highlight the smallest relevant inclusive one-based whole-line range without changing the code, then ask one targeted question that leads the candidate to calculate the exact output or next implementation step.",
            inputSchema: lineRangeInput,
            execute: executeWorkspaceTool,
          }),
          run_code: defineTool({
            description: "Execute the current code in the candidate editor and retrieve execution output.",
            inputSchema: noInput,
            execute: executeWorkspaceTool,
          }),
        }),
        ...(tools.choice && {
          get_choice_state: defineTool({
            description:
              "Get the on-screen MCQ and server-computed isCorrect result. MUST call before evaluating a selected answer. Trust isCorrect; never infer correctness from the learner's explanation or option wording.",
            inputSchema: noInput,
            execute: getChoiceState,
          }),
          highlight_choice: defineTool({
            description: "Highlight one option on the open MCQ by id (A, B, C, …) without changing the learner's selection. MUST call when discussing a specific option.",
            inputSchema: choiceOptionInput,
            execute: executeWorkspaceTool,
          }),
        }),
      };
    },
  },
});
