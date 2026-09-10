"use client";

import { Room, RoomEvent, type RpcInvocationData } from "livekit-client";
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
  parseAgentSurfaceEvent,
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

export function LiveKitWorkspaceProvider({
  children,
  room,
  onSurface,
}: {
  children: ReactNode;
  room: Room | null;
  onSurface: (surface: AgentSurface) => void;
}) {
  const handlers = useRef(new Map<WorkspaceMethod, WorkspaceHandler>());
  const waiters = useRef(
    new Map<WorkspaceMethod, Set<(handler: WorkspaceHandler) => void>>(),
  );

  const register = useCallback(
    (method: WorkspaceMethod, handler: WorkspaceHandler) => {
      handlers.current.set(method, handler);
      waiters.current.get(method)?.forEach((resolve) => resolve(handler));
      waiters.current.delete(method);
      return () => {
        if (handlers.current.get(method) === handler) handlers.current.delete(method);
      };
    },
    [],
  );

  const waitForHandler = useCallback((method: WorkspaceMethod) => {
    // Map whiteboard alias to canvas if canvas is registered
    const effectiveMethod =
      method === "workspace.whiteboard" && !handlers.current.has("workspace.whiteboard") && handlers.current.has("workspace.canvas")
        ? "workspace.canvas"
        : method;

    const current = handlers.current.get(effectiveMethod);
    if (current) return Promise.resolve(current);
    return new Promise<WorkspaceHandler>((resolve, reject) => {
      const pending = waiters.current.get(effectiveMethod) ?? new Set();
      pending.add(resolve);
      waiters.current.set(effectiveMethod, pending);
      setTimeout(() => {
        pending.delete(resolve);
        reject(new Error(`${method} is not open`));
      }, 2_500);
    });
  }, []);

  useEffect(() => {
    if (!room) return;

    // Handle surface changes from data packets
    function handleDataReceived(payload: Uint8Array) {
      try {
        // 1. Try parseAgentSurfaceEvent (handles interview_question_started, open_code_editor, etc.)
        const parsed = parseAgentSurfaceEvent(payload);
        if (parsed) {
          onSurface(parsed.surface);
          return;
        }

        // 2. Try JSON message with type or action
        const text = new TextDecoder().decode(payload);
        const data = JSON.parse(text);
        if (data && typeof data === "object") {
          const directParsed = parseAgentSurfaceMessage(data);
          if (directParsed) {
            onSurface(directParsed.surface);
          }
        }
      } catch (err) {
        console.warn("Error processing agent data packet:", err);
      }
    }

    room.on(RoomEvent.DataReceived, handleDataReceived);

    // Register RPC methods on the local participant
    const rpcMethods: WorkspaceMethod[] = [
      "workspace.code",
      "workspace.whiteboard",
      "workspace.canvas",
      "workspace.presentation",
    ];

    rpcMethods.forEach((method) => {
      room.localParticipant.registerRpcMethod(method, async (data: RpcInvocationData) => {
        try {
          const handler = await waitForHandler(method);
          const response = await handler(data.payload);
          return response;
        } catch (error) {
          return JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : "RPC call failed",
          });
        }
      });
    });

    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
      rpcMethods.forEach((method) => {
        room.localParticipant.unregisterRpcMethod(method);
      });
    };
  }, [room, onSurface, waitForHandler]);

  const value = useMemo(() => register, [register]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

// Backward compatibility alias for PipecatWorkspaceProvider
export const PipecatWorkspaceProvider = LiveKitWorkspaceProvider;
