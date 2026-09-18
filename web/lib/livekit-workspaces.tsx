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
  | "workspace.presentation";

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
  ((method: WorkspaceMethod, handler: WorkspaceHandler) => () => void) | null
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
  if (tool === "set_presentation_slide") return { method: "workspace.presentation", action: "go_to_slide", payload: { slideIndex: input.slide_index } };
  if (tool === "next_presentation_slide") return { method: "workspace.presentation", action: "next", payload: {} };
  if (tool === "previous_presentation_slide") return { method: "workspace.presentation", action: "previous", payload: {} };
  if (tool === "workspace_request" && typeof input.method === "string") {
    return { method: input.method as WorkspaceMethod, action: String(input.action ?? ""), payload: (input.payload as Record<string, unknown>) ?? {} };
  }
  return null;
}

export function LiveKitWorkspaceProvider({
  children,
  sessionId,
  runtimeToken,
  onSurface,
  onEndSession,
}: {
  children: ReactNode;
  sessionId?: string;
  runtimeToken?: string;
  onSurface: (surface: AgentSurface) => void;
  onEndSession?: () => void;
}) {
  const handlers = useRef(new Map<WorkspaceMethod, WorkspaceHandler>());
  const seen = useRef(new Set<string>());

  const register = useCallback(
    (method: WorkspaceMethod, handler: WorkspaceHandler) => {
      handlers.current.set(method, handler);
      return () => {
        if (handlers.current.get(method) === handler) handlers.current.delete(method);
      };
    },
    [],
  );

  useEffect(() => {
    if (!sessionId || !runtimeToken) return;
    let cancelled = false;
    const headers = { Authorization: `Bearer ${runtimeToken}` };

    async function run(command: { id: string; tool: string; input: unknown }) {
      if (seen.current.has(command.id)) return;
      seen.current.add(command.id);
      const input = command.input && typeof command.input === "object" && !Array.isArray(command.input)
        ? command.input as Record<string, unknown>
        : {};
      try {
        if (command.tool === "finish_session") {
          // Acknowledge the command immediately so the brain's tool loop resolves,
          // then wait a grace period for any remaining TTS audio to finish playing
          // before tearing down the WebRTC connection.
          await fetch(`/api/sessions/${sessionId}/commands/${command.id}`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ result: { ok: true } }),
          });
          await new Promise((resolve) => setTimeout(resolve, 5000));
          onEndSession?.();
          return;
        }
        if (command.tool === "surface") {
          const action = String(input.action ?? input.type ?? "");
          const payload = (input.payload as Record<string, unknown>) ?? input;
          const parsed = parseAgentSurfaceMessage({ ...payload, type: action });
          if (parsed) onSurface(parsed.surface);
          await fetch(`/api/sessions/${sessionId}/commands/${command.id}`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ result: { ok: true, action } }),
          });
          return;
        }
        const routed = workspaceMethodFor(command.tool, input);
        if (!routed) throw new Error(`Unsupported workspace tool ${command.tool}`);
        const handler = handlers.current.get(routed.method)
          ?? (routed.method === "workspace.canvas" ? handlers.current.get("workspace.whiteboard") : undefined);
        if (!handler) throw new Error(`${routed.method} is not open`);
        const raw = await handler(JSON.stringify({ action: routed.action, payload: routed.payload }));
        let result: unknown = raw;
        try { result = JSON.parse(raw); } catch { /* keep string */ }
        await fetch(`/api/sessions/${sessionId}/commands/${command.id}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ result }),
        });
      } catch (error) {
        await fetch(`/api/sessions/${sessionId}/commands/${command.id}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "failed", result: { ok: false, error: error instanceof Error ? error.message : String(error) } }),
        }).catch(() => {});
      }
    }

    async function poll() {
      while (!cancelled) {
        try {
          const response = await fetch(`/api/sessions/${sessionId}/commands`, { headers });
          if (response.ok) {
            const body = await response.json() as { commands?: Array<{ id: string; tool: string; input: unknown }> };
            for (const command of body.commands ?? []) await run(command);
          }
        } catch {
          // retry
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    void poll();
    return () => { cancelled = true; };
  }, [sessionId, runtimeToken, onSurface, onEndSession]);

  const value = useMemo(() => register, [register]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

export const PipecatWorkspaceProvider = LiveKitWorkspaceProvider;
