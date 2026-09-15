"use client";

import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { useWorkspaceHandlers } from "@/lib/livekit-workspaces";

/**
 * RPC contract mirrors the reference interview agent exactly: the only supported
 * action is `highlight_component`, which selects and scrolls to a labeled text
 * element on the canvas. The agent-kind guard lives in the workspace provider.
 */
const WHITEBOARD_RPC_METHOD = "workspace.whiteboard";

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Static import cannot work here: Excalidraw touches `window` at module scope and
// crashes Next.js SSR, so the module must load client-side only.
const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  {
    ssr: false,
    loading: () => <p className="p-4 text-sm text-muted-foreground">Loading whiteboard…</p>,
  },
);

export function Whiteboard() {
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() =>
    registerWorkspaceHandler(WHITEBOARD_RPC_METHOD, async (request) => {
      if (!api.current) throw new Error("Whiteboard is not ready");
      let parsed: { action?: string; payload?: Record<string, unknown> };
      try {
        parsed = JSON.parse(request) as { action?: string; payload?: Record<string, unknown> };
      } catch {
        throw new Error("Invalid whiteboard command");
      }
      if (parsed.action !== "highlight_component") {
        throw new Error(`Unsupported whiteboard action: ${String(parsed.action)}`);
      }
      const componentLabel = parsed.payload?.componentLabel;
      if (typeof componentLabel !== "string" || !componentLabel.trim()) {
        throw new Error("Missing component label");
      }
      const requestedLabel = normalizeLabel(componentLabel);
      const elements = api.current.getSceneElements();
      const textElement = elements.find((element) => {
        if (element.type !== "text") return false;
        const visibleLabel = normalizeLabel(element.originalText || element.text);
        return (
          visibleLabel === requestedLabel ||
          visibleLabel.includes(requestedLabel) ||
          requestedLabel.includes(visibleLabel)
        );
      });
      if (!textElement || textElement.type !== "text") {
        throw new Error("Whiteboard component label was not found");
      }
      const selectedIds: Record<string, true> = { [textElement.id]: true };
      if (textElement.containerId) selectedIds[textElement.containerId] = true;
      const selectedElements = elements.filter((element) => selectedIds[element.id]);
      api.current.updateScene({
        appState: { selectedElementIds: selectedIds },
      });
      api.current.scrollToContent(selectedElements, {
        animate: true,
        fitToContent: true,
      });
      return JSON.stringify({ ok: true, componentLabel: textElement.text });
    }));

  return (
    <div className="h-full overflow-hidden bg-[#121212] p-2">
      <Excalidraw
        excalidrawAPI={(instance: ExcalidrawImperativeAPI) => {
          api.current = instance;
        }}
        theme="dark"
      />
    </div>
  );
}
