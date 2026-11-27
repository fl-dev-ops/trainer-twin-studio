import { runtimeFromContext, studioFetch } from "./studio";

/**
 * Which workspace surfaces an agent (role play or twin) may use: Agent.data.tools, saved from the role play's Tools tab.
 * Missing or partial settings are off. The web parses the same shape (web/lib/agent-tools.ts).
 */
export type ToolSettings = {
  canvas: boolean; codeEditor: boolean; preview: boolean; choice: boolean;
  /** Knowledge-base search (search_knowledge, read_knowledge_document) in a role play. Not a screen surface. */
  knowledge?: boolean;
};
export const NO_TOOLS: ToolSettings = { canvas: false, codeEditor: false, preview: false, choice: false, knowledge: false };

const recordOrNull = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asRecord = (value: unknown) => recordOrNull(value) ?? {};

export function toolSettings(agentData: unknown): ToolSettings {
  const tools = asRecord(asRecord(agentData).tools);
  return {
    canvas: tools.canvas === true,
    codeEditor: tools.codeEditor === true,
    preview: tools.preview === true,
    choice: tools.choice === true,
    knowledge: tools.knowledge === true,
  };
}

/** Which switch each workspace tool belongs to. `surface` and `workspace_request` are checked by action / method. */
const TOOL_SWITCH: Record<string, keyof ToolSettings> = {
  get_presentation_state: "preview",
  set_presentation_slide: "preview",
  next_presentation_slide: "preview",
  previous_presentation_slide: "preview",
  add_canvas_component: "canvas",
  clear_canvas: "canvas",
  highlight_canvas_element: "canvas",
  highlight_whiteboard: "canvas",
  read_canvas_scene: "canvas",
  get_code_state: "codeEditor",
  read_code_range: "codeEditor",
  highlight_code: "codeEditor",
  run_code: "codeEditor",
  get_choice_state: "choice",
  highlight_choice: "choice",
};
/** The `surface` actions each switch allows (`close_surface` is allowed whenever any switch is on). */
export const SURFACE_ACTIONS: Record<string, keyof ToolSettings> = {
  open_whiteboard: "canvas",
  open_code_editor: "codeEditor",
  open_choice: "choice",
  open_pdf: "preview",
  open_image: "preview",
  open_presentation: "preview",
  highlight_pdf: "preview",
  highlight_document: "preview",
};
/** The browser workspace methods `workspace_request` may reach, by switch. */
const METHOD_SWITCH: Record<string, keyof ToolSettings> = {
  "workspace.code": "codeEditor",
  "workspace.canvas": "canvas",
  "workspace.whiteboard": "canvas",
  "workspace.choice": "choice",
  "workspace.presentation": "preview",
};

export const anyToolOn = (tools: ToolSettings) => tools.canvas || tools.codeEditor || tools.preview || tools.choice;

/**
 * Whether this workspace call is allowed by the session's switches. The tool list already leaves switched-off tools
 * out; this is the backstop for replays, recovery and the generic `surface` / `workspace_request` tools. Anything
 * unknown is refused.
 */
export function workspaceAllowed(tools: ToolSettings, toolName: string, input: unknown): boolean {
  const args = asRecord(input);
  if (toolName === "surface") {
    const action = String(args.action ?? "");
    if (action === "close_surface") return anyToolOn(tools);
    const owner = SURFACE_ACTIONS[action];
    return Boolean(owner && tools[owner]);
  }
  if (toolName === "workspace_request") {
    const owner = METHOD_SWITCH[String(args.method ?? "")];
    return Boolean(owner && tools[owner]);
  }
  const owner = TOOL_SWITCH[toolName];
  return Boolean(owner && tools[owner]);
}

export const TOOL_SWITCHED_OFF = {
  disabled: true,
  reason: "This workspace tool is not available in this conversation. Carry on without it.",
} as const;

type Auth = { initiator?: { principalId?: string } | null; current?: { principalId?: string; attributes?: Record<string, unknown> } | null };
type SessionCtx = { session?: { auth?: Auth } };

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<ToolSettings> }>();

/**
 * The current session's tool settings, from the agent data pinned when the session started (cached per session).
 * Anything that goes wrong reads as no tools: a lookup failure must never hand out a tool.
 */
export function sessionToolSettings(ctx: SessionCtx): Promise<ToolSettings> {
  const auth = ctx.session?.auth;
  const attributes = auth?.current?.attributes ?? {};
  if (runtimeFromContext(ctx)) return Promise.resolve(NO_TOOLS);
  const orgId = (typeof attributes.orgId === "string" && attributes.orgId) || auth?.initiator?.principalId || auth?.current?.principalId;
  const sessionId = typeof attributes.sessionId === "string" ? attributes.sessionId : undefined;
  const agentSlug = typeof attributes.agentSlug === "string" ? attributes.agentSlug : undefined;
  if (!orgId || (!sessionId && !agentSlug)) return Promise.resolve(NO_TOOLS);
  const key = `${orgId}:${sessionId ?? ""}:${agentSlug ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = studioFetch<{ agent?: { data?: unknown } | null }>(orgId, { action: "getSessionContext", sessionId, agentSlug })
    .then((result) => toolSettings(result.agent?.data))
    .catch(() => {
      cache.delete(key);
      return NO_TOOLS;
    });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

/**
 * The prompt's description of the workspace for this call: only the switched-on surfaces. Empty when nothing is on
 * (the caller keeps its own "no workspace" wording). `client` frames it for a client role play. Tool names and payloads
 * here match the tool descriptions (chat/agent/tools/workspace.ts) word for word; a scenario's skill decides WHEN a
 * surface is used, this block only says HOW.
 */
export function formatWorkspaceBlock(tools: ToolSettings, { client }: { client: boolean }): string {
  if (!anyToolOn(tools)) return "";
  const when = client
    ? "Stay in character as the client while you use it. Open a surface only when it genuinely helps the call or the learner asks."
    : "Open a surface when the skill's procedure calls for it or the learner asks; don't wait to be asked.";
  const lines = [
    tools.canvas &&
      "- Whiteboard: surface open_whiteboard { questionId, question } shows a blank board with the question on top. read_canvas_scene when the learner says they drew or changed something, and before you ask about their diagram; an empty scene means the board is blank, so never describe a drawing you have not read. highlight_whiteboard { component_label } points at one label exactly as read_canvas_scene returned it.",
    tools.codeEditor &&
      "- Code editor: surface open_code_editor { questionId, question, language, starterCode, readOnly }: readOnly true with the snippet as starterCode for code to read; readOnly false with starterCode \"\" for code to write. Read with get_code_state or read_code_range before reacting. highlight_code { from_line, to_line } marks the smallest relevant whole-line range. run_code runs it and returns the output.",
    tools.choice &&
      "- Multiple choice: surface open_choice { questionId, question, options: [{ id, text }], correctOptionId, code? }. The learner sees only this payload: when the question is about code, put the full snippet in code as { language, content } (it shows above the question). Never read the options aloud. get_choice_state before reacting to their pick: selectedId is their answer even before they submit; trust isCorrect, which never reaches the learner. highlight_choice { option_id } points at one option.",
    tools.preview &&
      "- Preview: surface open_pdf { fileId }, open_image { fileId }, open_presentation { fileId, slideNumber? }; fileIds only from ATTACHED ARTIFACTS, never invented. Read a PDF with read_document. Before quoting or referring to a specific line in a PDF, call surface({ action: \"highlight_document\", payload: { fileId, highlightQuery } }) with an exact phrase from read_document. Do this on the opening turn too; opening the PDF is not a substitute for highlighting. If the highlight fails, do not claim it succeeded. Slides: get_presentation_state, set_presentation_slide (zero-based slide_index), next_presentation_slide, previous_presentation_slide.",
  ].filter(Boolean);
  return `# Workspace for this call
${when} Never call it a tool or a system.
- One surface at a time: opening one replaces the last. surface close_surface when you move to something that needs none.
- A new question gets a new questionId and a fresh surface. Never reopen a surface for a follow-up: it wipes the learner's work.
- Read before you react (read_canvas_scene, get_code_state, read_code_range, get_choice_state, read_document); never guess what is on screen.
- To talk about one part, highlight it first (highlight_whiteboard, highlight_code, highlight_choice, highlight_document), then say "the highlighted …". Never read code or options aloud.
${lines.join("\n")}`;
}

/**
 * The call settings saved on the role play's (or twin's) Settings tab, Agent.data.before (older twins:
 * data.twinSettings). The browser enforces them (web/lib/context-upload.ts); the prompt states them so the AI never
 * asks for something the call can't do (a screen share that is off, a file nobody can send).
 */
export type CallSettings = { screenShare: boolean; preUpload: boolean; duringUpload: boolean };
export const NO_CALL_SETTINGS: CallSettings = { screenShare: false, preUpload: false, duringUpload: false };

export function callSettings(agentData: unknown): CallSettings {
  const data = asRecord(agentData);
  const before = recordOrNull(data.before) ?? asRecord(data.twinSettings);
  return { screenShare: before.preScreenshare === true, preUpload: before.preUpload === true, duringUpload: before.duringUpload === true };
}

/** Whether documents can reach this call (attached before it, or during it). */
export const documentsOn = (call: CallSettings, attached = 0) => call.preUpload || call.duringUpload || attached > 0;

/** The prompt's lines for the screen, documents and knowledge search of this call: what is on, and what is not. */
export function formatCallBlock(call: CallSettings, tools: ToolSettings, { attached = 0, knowledgeSwitch = true }: { attached?: number; knowledgeSwitch?: boolean } = {}): string {
  const lines = [
    call.screenShare
      ? "- Screen: the learner shares their whole screen. You see it only through [SCREEN OBSERVER CONTEXT] notes; never claim to see more than they describe."
      : "- Screen: screen sharing is off for this call. Never ask the learner to share or show their screen.",
    documentsOn(call, attached)
      ? `- Documents: ${attached > 0 ? "the ones listed under ATTACHED ARTIFACTS" : "none attached yet"}${call.duringUpload ? "; the learner may also attach one during the call (it arrives as [ATTACHED <id>])" : ""}. Read one with read_document before you refer to it; quote only what it says.${call.duringUpload ? "" : " Never ask the learner to attach a file during the call."}`
      : "- Documents: the learner cannot attach files in this call. Never ask them to upload or send a document.",
    knowledgeSwitch &&
      (tools.knowledge
        ? "- Knowledge search: on. Call search_knowledge before you judge a technical answer as right, wrong or incomplete, and read_knowledge_document to read a result in full. If nothing relevant comes back, ask a neutral question instead of judging."
        : "- Knowledge search: off."),
  ].filter(Boolean);
  return `# This call's settings\n${lines.join("\n")}`;
}
