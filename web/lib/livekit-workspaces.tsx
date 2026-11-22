"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  parseAgentSurfaceMessage,
  type AgentSurface,
} from "@/lib/agent-surface-events";

export type WorkspaceHandler = (request: string) => Promise<string>;
export type WorkspaceMethod =
  | "workspace.code"
  | "workspace.canvas"
  | "workspace.whiteboard"
  | "workspace.presentation"
  | "workspace.choice"
  | "workspace.preview";

export function unwrapWorkspaceResult(raw: string): unknown {
  try {
    const response = JSON.parse(raw) as Record<string, unknown>;
    if (!response?.ok) throw new Error(String(response?.error ?? "Workspace command failed"));
    return response.result ?? response;
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error(String(e));
  }
}

const WorkspaceContext = createContext<
  ((method: WorkspaceMethod, handler: WorkspaceHandler, ready?: () => boolean) => () => void) | null
>(null);

export function useWorkspaceHandlers() {
  const register = useContext(WorkspaceContext);
  if (!register) throw new Error("Workspace component is outside LiveKitWorkspaceProvider");
  return register;
}

function workspaceMethodFor(tool: string, input: Record<string, unknown>): { method: WorkspaceMethod; action: string; payload: Record<string, unknown> } | null {
  if (tool === "read_code_range") return { method: "workspace.code", action: "get_range", payload: { fromLine: input.from_line, toLine: input.to_line } };
  if (tool === "highlight_code") return { method: "workspace.code", action: "highlight_range", payload: { fromLine: input.from_line, toLine: input.to_line } };
  if (tool === "get_code_state") return { method: "workspace.code", action: "get_state", payload: {} };
  if (tool === "run_code") return { method: "workspace.code", action: "run", payload: {} };
  if (tool === "highlight_whiteboard") return { method: "workspace.whiteboard", action: "highlight_component", payload: { componentLabel: input.component_label ?? input.componentLabel } };
  if (tool === "read_canvas_scene") return { method: "workspace.canvas", action: "get_scene", payload: {} };
  if (tool === "highlight_canvas_element") return { method: "workspace.canvas", action: "highlight", payload: input };
  if (tool === "add_canvas_component") return { method: "workspace.canvas", action: "add_component", payload: input };
  if (tool === "clear_canvas") return { method: "workspace.canvas", action: "clear", payload: {} };
  if (tool === "get_presentation_state") return { method: "workspace.presentation", action: "get_state", payload: {} };
  if (tool === "set_presentation_slide") return { method: "workspace.presentation", action: "go_to_slide", payload: { slideNumber: Number(input.slide_index) + 1 } };
  if (tool === "next_presentation_slide") return { method: "workspace.presentation", action: "next", payload: {} };
  if (tool === "previous_presentation_slide") return { method: "workspace.presentation", action: "previous", payload: {} };
  if (tool === "get_choice_state") return { method: "workspace.choice", action: "get_state", payload: {} };
  if (tool === "highlight_choice") return { method: "workspace.choice", action: "highlight", payload: { optionId: input.option_id ?? input.optionId } };
  if (tool === "workspace_request" && typeof input.method === "string") {
    return { method: input.method as WorkspaceMethod, action: String(input.action ?? ""), payload: (input.payload as Record<string, unknown>) ?? {} };
  }
  return null;
}
export function parseWorkspaceCommandSurface(command: {
  id: string;
  tool: string;
  input: unknown;
}): { surface: AgentSurface } | null {
  if (command.tool !== "surface" && command.tool !== "start_resume_question") return null;
  const input = command.input && typeof command.input === "object" && !Array.isArray(command.input)
    ? command.input as Record<string, unknown>
    : {};
  const action = String(input.action ?? input.type ?? "");
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown> : input;
  if (["open_pdf", "highlight_pdf", "highlight_document", "open_image"].includes(action) &&
      !(typeof payload.fileId === "string" && payload.fileId.trim()) &&
      !(typeof payload.sourceUrl === "string" && /^(https?:\/\/|\/api\/documents\/)/.test(payload.sourceUrl))) return null;
  if (["highlight_pdf", "highlight_document"].includes(action) &&
      ![payload.highlightQuery, payload.highlight, payload.query].some((value) => typeof value === "string" && value.trim())) return null;
  if (action === "open_choice" && (!Array.isArray(payload.options) || payload.options.length < 2)) return null;
  const hasId = Boolean(
    (typeof payload.eventId === "string" && payload.eventId.trim().length > 0) ||
    (typeof payload.questionId === "string" && payload.questionId.trim().length > 0),
  );
  return parseAgentSurfaceMessage({
    ...payload,
    type: action,
    ...(command.tool === "start_resume_question" ? { commandId: command.id } : {}),
    ...(["open_code_editor", "open_whiteboard", "open_choice"].includes(action) && !hasId
      ? { commandId: command.id, questionId: command.id }
      : {}),
  });
}


export function LiveKitWorkspaceProvider({
  children,
  sessionId,
  runtimeToken,
  onSurface,
  onEndSession,
  active = true,
}: {
  children: ReactNode;
  sessionId?: string;
  runtimeToken?: string;
  onSurface: (surface: AgentSurface) => void | Promise<{ status: string }>;
  onEndSession?: () => void;
  /** While false (e.g. intro video still playing), pending commands are not polled. */
  active?: boolean;
}) {
  const handlers = useRef(new Map<WorkspaceMethod, { execute: WorkspaceHandler; ready: () => boolean }>());
  const results = useRef(new Map<string, Promise<{ status: "completed" | "failed"; result: unknown }>>());
  const consumerId = useRef<string | undefined>(undefined);
  const lastSurfaceKey = useRef<string | undefined>(undefined);
  // Latest callbacks, read at call time: callers pass inline functions, which must not restart polling each render.
  const onSurfaceRef = useRef(onSurface);
  const onEndSessionRef = useRef(onEndSession);
  useEffect(() => {
    onSurfaceRef.current = onSurface;
    onEndSessionRef.current = onEndSession;
  });

  const register = useCallback(
    (method: WorkspaceMethod, handler: WorkspaceHandler, ready: () => boolean = () => true) => {
      const entry = { execute: handler, ready };
      handlers.current.set(method, entry);
      return () => {
        if (handlers.current.get(method) === entry) handlers.current.delete(method);
      };
    },
    [],
  );

  useEffect(() => {
    if (!sessionId || !runtimeToken || !active) return;
    consumerId.current ??= crypto.randomUUID();
    const consumer = consumerId.current;
    const controller = new AbortController();
    const signal = controller.signal;
    const headers = { Authorization: `Bearer ${runtimeToken}` };

    async function handlerFor(method: WorkspaceMethod, previous?: WorkspaceHandler) {
      const until = Date.now() + 12_000;
      while (!signal.aborted && Date.now() < until) {
        const handler = handlers.current.get(method)
          ?? (method === "workspace.canvas" ? handlers.current.get("workspace.whiteboard") : undefined);
        if (handler?.ready() && handler.execute !== previous) return handler.execute;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`${method} is not ready`);
    }

    async function execute(command: { id: string; tool: string; input: unknown }) {
      if (signal.aborted) throw new Error("Session workspace disconnected");
      const input = command.input && typeof command.input === "object" && !Array.isArray(command.input)
        ? command.input as Record<string, unknown>
        : {};
      try {
        if (command.tool === "finish_session") {
          // Acknowledge the command immediately so the brain's tool loop resolves,
          // then wait a grace period for any remaining TTS audio to finish playing
          // before tearing down the WebRTC connection.
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return { status: "completed" as const, result: { ok: true } };
        }
        if (command.tool === "surface" || command.tool === "start_resume_question") {
          const parsed = parseWorkspaceCommandSurface(command);
          if (!parsed) throw new Error("Unsupported or invalid workspace surface");
          const surface = parsed.surface;
          const method: WorkspaceMethod | undefined = surface?.tool === "code" ? "workspace.code"
            : surface?.tool === "canvas" ? "workspace.whiteboard"
            : surface?.tool === "choice" ? "workspace.choice"
            : surface?.tool === "presentation" ? "workspace.presentation"
            : surface ? "workspace.preview" : undefined;
          const key = `${sessionId}:${surface?.key ?? "none"}`;
          const previous = key !== lastSurfaceKey.current && method ? handlers.current.get(method)?.execute : undefined;
          lastSurfaceKey.current = key;
          const surfaceResult = await onSurfaceRef.current(surface);
          // On a replacement, the previous panel may still be registered until React commits the new one.
          if (method && command.tool !== "start_resume_question") {
            const handler = await handlerFor(method, previous);
            if (signal.aborted) throw new Error("Session workspace disconnected");
            unwrapWorkspaceResult(await handler(JSON.stringify({ action: "get_state" })));
            if (surface?.tool === "pdf" && surface.highlightQuery) {
              unwrapWorkspaceResult(await handler(JSON.stringify({ action: "highlight", payload: { query: surface.highlightQuery } })));
            }
          }
          return { status: "completed" as const, result: { ok: true, action: input.action ?? input.type,
            ...(command.tool === "start_resume_question" ? surfaceResult ?? { status: "viewer_unavailable" } : surfaceResult) } };
        }
        const routed = workspaceMethodFor(command.tool, input);
        if (!routed) throw new Error(`Unsupported workspace tool ${command.tool}`);
        const handler = await handlerFor(routed.method);
        if (signal.aborted) throw new Error("Session workspace disconnected");
        const raw = await handler(JSON.stringify({ action: routed.action, payload: routed.payload }));
        unwrapWorkspaceResult(raw);
        return { status: "completed" as const, result: JSON.parse(raw) as unknown };
      } catch (error) {
        return { status: "failed" as const, result: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      }
    }

    async function run(command: { id: string; tool: string; input: unknown }) {
      const key = `${sessionId}:${command.id}`;
      let execution = results.current.get(key);
      if (!execution) {
        const claim = await fetch(`/api/sessions/${sessionId}/commands/${command.id}`, {
          method: "POST", signal,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "claim", consumerId: consumer }),
        });
        if (!claim.ok) throw new Error("Workspace claim failed");
        if (!(await claim.json()).claimed || signal.aborted) return;
        execution = results.current.get(key) ?? execute(command);
        results.current.set(key, execution);
      }
      const outcome = await execution;
      if (signal.aborted) return;
      const response = await fetch(`/api/sessions/${sessionId}/commands/${command.id}`, {
        method: "POST", signal,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...outcome, action: "complete", consumerId: consumer }),
      });
      if (!response.ok) throw new Error("Workspace acknowledgement failed");
      if (command.tool === "finish_session" && outcome.status === "completed" && !signal.aborted) onEndSessionRef.current?.();
    }

    async function poll() {
      while (!signal.aborted) {
        try {
          const response = await fetch(`/api/sessions/${sessionId}/commands`, { headers, signal });
          if (response.ok) {
            const body = await response.json() as { commands?: Array<{ id: string; tool: string; input: unknown }> };
            for (const command of body.commands ?? []) {
              if (signal.aborted) break;
              await run(command);
            }
          }
        } catch {
          // retry
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    void poll();
    return () => { controller.abort(); };
  }, [sessionId, runtimeToken, active]);

  const value = useMemo(() => register, [register]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

export const PipecatWorkspaceProvider = LiveKitWorkspaceProvider;
