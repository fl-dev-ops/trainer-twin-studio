"use client";

import type { PipecatClient } from "@pipecat-ai/client-js";
import { RTVIEvent } from "@pipecat-ai/client-js";
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

type WorkspaceHandler = (request: string) => Promise<string>;
type WorkspaceMethod =
  | "workspace.code"
  | "workspace.canvas"
  | "workspace.presentation";

export type WorkspaceRequest = {
  type: "workspace-request";
  requestId?: string;
  eventId?: string;
  method: "surface" | WorkspaceMethod;
  action: string;
  payload: Record<string, unknown>;
};

const methods = new Set([
  "surface",
  "workspace.code",
  "workspace.canvas",
  "workspace.presentation",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseWorkspaceRequest(value: unknown): WorkspaceRequest | null {
  const data = record(value);
  if (!data) return null;
  const payload = record(data.payload) ?? {};
  const method = data.method;
  const requestId = data.requestId;
  return typeof method === "string" &&
    methods.has(method) &&
    typeof data.action === "string" &&
    (method === "surface" ||
      (typeof requestId === "string" && requestId.length <= 128)) &&
    (data.eventId === undefined ||
      (typeof data.eventId === "string" && data.eventId.length <= 128))
    ? ({ ...data, type: "workspace-request", payload } as WorkspaceRequest)
    : null;
}

export function parseWorkspaceCommand(value: unknown): WorkspaceRequest | null {
  const message = record(value);
  const payload = record(message?.payload);
  if (!payload) return null;
  if (message?.command === "surface") {
    return parseWorkspaceRequest({
      method: "surface",
      action: payload.action,
      eventId: payload.eventId,
      payload: payload.payload,
    });
  }
  return message?.command === "workspace.request"
    ? parseWorkspaceRequest(payload)
    : null;
}

export function unwrapWorkspaceResult(raw: string): unknown {
  const response = record(JSON.parse(raw));
  if (!response?.ok) throw new Error(String(response?.error ?? "Workspace command failed"));
  return response.result ?? response;
}

const WorkspaceContext = createContext<
  ((method: WorkspaceMethod, handler: WorkspaceHandler) => () => void) | null
>(null);

export function useWorkspaceHandlers() {
  const register = useContext(WorkspaceContext);
  if (!register) throw new Error("Workspace component is outside PipecatWorkspaceProvider");
  return register;
}

export function PipecatWorkspaceProvider({
  children,
  client,
  onSurface,
}: {
  children: ReactNode;
  client: PipecatClient;
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
    const current = handlers.current.get(method);
    if (current) return Promise.resolve(current);
    return new Promise<WorkspaceHandler>((resolve, reject) => {
      const pending = waiters.current.get(method) ?? new Set();
      pending.add(resolve);
      waiters.current.set(method, pending);
      setTimeout(() => {
        pending.delete(resolve);
        reject(new Error(`${method} is not open`));
      }, 1_500);
    });
  }, []);

  useEffect(() => {
    async function handleUICommand(message: unknown) {
      const request = parseWorkspaceCommand(message);
      if (!request) return;
      try {
        if (request.method === "surface") {
          const event = parseAgentSurfaceMessage({
            ...request.payload,
            type: request.action,
            eventId: request.eventId,
          });
          if (!event) throw new Error(`Unsupported surface action: ${request.action}`);
          onSurface(event.surface);
          return;
        }
        const handler = await waitForHandler(request.method);
        const result = unwrapWorkspaceResult(
          await handler(JSON.stringify({ action: request.action, payload: request.payload })),
        );
        client.sendUIEvent("workspace.result", {
          requestId: request.requestId,
          result,
        });
      } catch (error) {
        if (request.requestId) {
          client.sendUIEvent("workspace.result", {
            requestId: request.requestId,
            error: error instanceof Error ? error.message : "Workspace command failed",
          });
        }
      }
    }

    client.on(RTVIEvent.UICommand, handleUICommand);
    return () => {
      client.off(RTVIEvent.UICommand, handleUICommand);
    };
  }, [client, onSurface, waitForHandler]);

  const value = useMemo(() => register, [register]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}
