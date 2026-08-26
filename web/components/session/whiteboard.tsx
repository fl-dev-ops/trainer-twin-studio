"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useWorkspaceHandlers } from "@/lib/pipecat-workspaces";
import "@excalidraw/excalidraw/index.css";

const CANVAS_RPC_METHOD = "workspace.canvas";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false },
);

export function Whiteboard() {
  const { resolvedTheme } = useTheme();
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() =>
    registerWorkspaceHandler(CANVAS_RPC_METHOD, async (request) => {
      const { handleCanvasRpc } = await import("@/lib/canvas-rpc");
      return handleCanvasRpc(request, { api: api.current });
    }),
  [registerWorkspaceHandler]);

  return (
    <div className="h-full overflow-hidden p-2">
      <Excalidraw
        excalidrawAPI={(instance) => {
          api.current = instance;
        }}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
      />
    </div>
  );
}
