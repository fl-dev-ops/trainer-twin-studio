import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { anyToolOn, sessionToolSettings, type ToolSettings } from "../lib/agent-tools";
import { activeMcqState, gradeMcqSelection, prepareMcqPayload } from "../lib/mcq-state";
import { executeWorkspaceTool } from "../lib/workspace-tools";
import { presentationTools } from "../lib/workspace/presentation-tools";

/*
 * The workspace tools this session's agent may use (Agent.data.tools, the role play's Tools tab), resolved once when the
 * session starts: a switched-off surface's tools are not in the model's tool list at all. Tool names and behaviour are
 * the same as the static tools they replace. Preview includes PDF/image surfaces and presentation navigation.
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

/** The surface tool's description: only the actions this session's switches allow, with their exact payloads. */
function surfaceDescription(tools: ToolSettings): string {
  const actions = [
    tools.canvas &&
      "open_whiteboard { questionId, question }: a blank whiteboard with the question on top.",
    tools.codeEditor &&
      "open_code_editor { questionId, question, language, starterCode, readOnly }: readOnly true + the snippet as starterCode = code to read; readOnly false + starterCode \"\" = a blank editor to write in.",
    tools.choice &&
      "open_choice { questionId, question, options: [{ id, text }], correctOptionId, code? }: a multiple-choice card. The learner sees only this payload: if the question is about code, put the complete snippet in code as { language, content } (shown above the question). correctOptionId stays private.",
    tools.preview &&
      "open_pdf { fileId }, open_image { fileId }, open_presentation { fileId, slideNumber? }: show an attached file. highlight_document { fileId, highlightQuery }: highlight an exact phrase (copied from read_document) in the open PDF.",
    "close_surface: clear the screen.",
  ].filter(Boolean);
  return `Open, change or close what the learner sees; one action per call, opening one replaces the last. A new question gets a new questionId (a fresh surface); never reopen for a follow-up, it wipes the learner's work. fileIds only from ATTACHED ARTIFACTS. Actions: ${actions.join(" ")}`;
}

export default defineDynamic(async (ctx) => {
      // Once per session (eve runs this before every model call): this agent's tool switches, as JSON.
      const tools = await ctx.memo(["workspace-tools", ctx.session.id], () => sessionToolSettings(ctx));
      if (!anyToolOn(tools)) return null;
      return {
        surface: defineTool({ description: surfaceDescription(tools), inputSchema: surfaceInput, execute: runSurface }),
        workspace_request: defineTool({
          description: "Low-level browser workspace call (method, action, payload). Use the named workspace tools; this is only for an action none of them covers.",
          inputSchema: workspaceRequestInput,
          execute: executeWorkspaceTool,
        }),
        ...(tools.preview && presentationTools),
        ...(tools.canvas && {
          add_canvas_component: defineTool({
            description: "Draw one labelled box on the whiteboard yourself (e.g. a given starting component). Never to redraw the learner's work.",
            inputSchema: canvasComponentInput,
            execute: executeWorkspaceTool,
          }),
          clear_canvas: defineTool({ description: "Erase the whole whiteboard, including the learner's drawing. Only when the learner asks.", inputSchema: noInput, execute: executeWorkspaceTool }),
          highlight_canvas_element: defineTool({
            description: "Highlight and scroll to one whiteboard element by its id from read_canvas_scene. Prefer highlight_whiteboard when you know the label.",
            inputSchema: canvasElementInput,
            execute: executeWorkspaceTool,
          }),
          highlight_whiteboard: defineTool({
            description:
              "Point at one component on the learner's whiteboard by its label, exactly as read_canvas_scene returned it (never invented). Call read_canvas_scene first. Then ask about \"the highlighted <label>\". Only for a diagram that answers the current question.",
            inputSchema: whiteboardLabelInput,
            execute: executeWorkspaceTool,
          }),
          read_canvas_scene: defineTool({
            description:
              "Read everything on the whiteboard: labels, ids and connections. Call when the learner says they drew or changed something, and before you ask about or highlight their diagram. An empty result means the board is blank: never describe a drawing you have not read.",
            inputSchema: noInput,
            execute: executeWorkspaceTool,
          }),
        }),
        ...(tools.codeEditor && {
          get_code_state: defineTool({
            description: "Read the editor: the full code, its language, cursor and selection. Call before reacting to anything the learner wrote.",
            inputSchema: noInput,
            execute: executeWorkspaceTool,
          }),
          read_code_range: defineTool({
            description:
              "Read editor lines from_line to to_line (one-based, inclusive), numbered. Use it to pick the exact lines for highlight_code; lines 1 to 200 when unsure. Never read code aloud.",
            inputSchema: lineRangeInput,
            execute: executeWorkspaceTool,
          }),
          highlight_code: defineTool({
            description:
              "Highlight editor lines from_line to to_line (one-based, inclusive; the smallest whole-line range that matters) without changing the code. Read the code first (read_code_range or get_code_state). Then ask about \"the highlighted line\" or \"lines\"; never read the code aloud.",
            inputSchema: lineRangeInput,
            execute: executeWorkspaceTool,
          }),
          run_code: defineTool({
            description: "Run the editor's current code and return its output and errors.",
            inputSchema: noInput,
            execute: executeWorkspaceTool,
          }),
        }),
        ...(tools.choice && {
          get_choice_state: defineTool({
            description:
              "Read the open multiple-choice card: selectedId, submitted, and isCorrect (graded on the server against correctOptionId). Call before reacting to the learner's pick. selectedId is their answer even if not submitted; never ask them to press Submit. Trust isCorrect; never judge from their explanation or the option wording.",
            inputSchema: noInput,
            execute: getChoiceState,
          }),
          highlight_choice: defineTool({
            description: "Point at one option on the open card by id (A, B, C, …) without changing the learner's selection. Call before you talk about a specific option.",
            inputSchema: choiceOptionInput,
            execute: executeWorkspaceTool,
          }),
        }),
      };
});
