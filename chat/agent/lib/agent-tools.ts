import { studioFetch } from "./studio";

/**
 * Which workspace surfaces an agent (role play or twin) may use: Agent.data.tools, saved from the role play's Tools tab.
 * Missing or partial settings are off. The web parses the same shape (web/lib/agent-tools.ts).
 */
export type ToolSettings = { canvas: boolean; codeEditor: boolean; preview: boolean; choice: boolean };
export const NO_TOOLS: ToolSettings = { canvas: false, codeEditor: false, preview: false, choice: false };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function toolSettings(agentData: unknown): ToolSettings {
  const tools = asRecord(asRecord(agentData).tools);
  return {
    canvas: tools.canvas === true,
    codeEditor: tools.codeEditor === true,
    preview: tools.preview === true,
    choice: tools.choice === true,
  };
}

/** Which switch each workspace tool belongs to. `surface` and `workspace_request` are checked by action / method. */
const TOOL_SWITCH: Record<string, keyof ToolSettings> = {
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
  highlight_pdf: "preview",
  highlight_document: "preview",
};
/** The browser workspace methods `workspace_request` may reach, by switch. Slides have no switch yet. */
const METHOD_SWITCH: Record<string, keyof ToolSettings> = {
  "workspace.code": "codeEditor",
  "workspace.canvas": "canvas",
  "workspace.whiteboard": "canvas",
  "workspace.choice": "choice",
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
 * The prompt's description of the workspace for this call: only the switched-on surfaces, a line or two each. Empty
 * when nothing is on (the caller keeps its own "no workspace" wording). `client` frames it for a client role play.
 */
export function formatWorkspaceBlock(tools: ToolSettings, { client }: { client: boolean }): string {
  if (!anyToolOn(tools)) return "";
  const who = client ? "Stay in character as the client while you use it" : "Keep talking to the learner while you use it";
  const lines = [
    tools.canvas &&
      "- Whiteboard: open it with surface({ action: \"open_whiteboard\" }) when a quick sketch helps (numbers, a comparison, a plan). Use read_canvas_scene when the learner says they drew or changed something, and highlight_whiteboard to point at one label they wrote.",
    tools.codeEditor &&
      "- Code editor: open it with surface({ action: \"open_code_editor\", payload: { questionId, question, language, starterCode, readOnly } }) when the conversation calls for code. Read what they wrote with get_code_state or read_code_range before reacting, and run it with run_code.",
    tools.preview &&
      "- Documents: show a PDF the learner attached with surface({ action: \"open_pdf\", payload: { fileId } }) and point at a phrase with surface({ action: \"highlight_document\", payload: { fileId, highlightQuery } }). Read it first with read_document. Only use fileIds from ATTACHED ARTIFACTS; never invent one.",
    tools.choice &&
      "- Multiple choice: put a short question on screen with surface({ action: \"open_choice\", payload: { questionId, question, options: [{ id, text }], correctOptionId } }). Call get_choice_state before reacting to their pick and trust its isCorrect.",
  ].filter(Boolean);
  return `# Workspace for this call
You can show these on the learner's screen. Open one only when it genuinely helps the conversation or the learner asks for it, never as a gimmick. ${who}, and never describe it as a tool or a system. Close it with surface({ action: "close_surface" }) when you move on.
${lines.join("\n")}`;
}
