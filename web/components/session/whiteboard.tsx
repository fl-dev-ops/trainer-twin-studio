"use client";

import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspaceHandlers } from "@/lib/livekit-workspaces";

/**
 * Browser actions for reading, adding, clearing and highlighting canvas elements.
 * Tool availability is enforced by chat; execution waits for Excalidraw to mount.
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

export function Whiteboard({
  question,
  onContentChange,
  onSubmit,
}: {
  question: string;
  onContentChange?: () => void;
  onSubmit: (submission: { blob: Blob; imageSha256: string }) => Promise<boolean>;
}) {
  const registerWorkspaceHandler = useWorkspaceHandlers();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const sceneRevisionRef = useRef("");
  const [isExporting, setIsExporting] = useState(false);
  const [submittedQuestion, setSubmittedQuestion] = useState<string>();
  const submitted = submittedQuestion === question;

  useEffect(() => {
    if (api.current) {
      api.current.updateScene({ elements: [] });
    }
  }, [question]);

  useEffect(() =>
    registerWorkspaceHandler(WHITEBOARD_RPC_METHOD, async (request) => {
      if (!api.current) throw new Error("Whiteboard is not ready");
      let parsed: { action?: string; payload?: Record<string, unknown> };
      try {
        parsed = JSON.parse(request) as { action?: string; payload?: Record<string, unknown> };
      } catch {
        throw new Error("Invalid whiteboard command");
      }

      if (parsed.action === "get_state") return JSON.stringify({ ok: true, result: { ready: true } });
      if (parsed.action === "add_component") {
        const label = String(parsed.payload?.label ?? "").trim();
        const x = Number(parsed.payload?.x ?? 100);
        const y = Number(parsed.payload?.y ?? 100);
        if (!label || label.length > 200 || !Number.isInteger(x) || !Number.isInteger(y)) throw new Error("Invalid canvas component");
        const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
        const elements = convertToExcalidrawElements([{ type: "rectangle", x, y, width: 180, height: 70, label: { text: label } }]);
        api.current!.updateScene({ elements: [...api.current!.getSceneElements(), ...elements] });
        return JSON.stringify({ ok: true, result: { element_id: elements[0].id, label } });
      }
      if (parsed.action === "get_scene") {
        const elements = api.current.getSceneElements().filter((el) => !el.isDeleted);
        const textElements = elements
          .filter((el) => el.type === "text")
          .map((el) => ({
            id: el.id,
            label: (el.originalText || el.text || "").trim(),
            x: Math.round(el.x),
            y: Math.round(el.y),
          }))
          .filter((el) => el.label.length > 0);

        const labels = textElements.map((el) => el.label);
        const shapesCount = elements.filter((el) => el.type !== "text").length;

        return JSON.stringify({
          ok: true,
          elementsCount: elements.length,
          componentsCount: textElements.length,
          shapesCount,
          labels,
          components: textElements,
          summary: textElements.length > 0
            ? `Whiteboard contains ${textElements.length} labeled components: ${labels.join(", ")}.`
            : elements.length > 0
            ? `Whiteboard contains ${elements.length} drawn shapes without text labels.`
            : "Whiteboard is currently empty.",
        });
      }

      if (parsed.action === "clear") {
        api.current.updateScene({ elements: [] });
        return JSON.stringify({ ok: true });
      }

      if (parsed.action !== "highlight_component" && parsed.action !== "highlight") {
        throw new Error(`Unsupported whiteboard action: ${String(parsed.action)}`);
      }
      const componentLabel = (parsed.payload?.componentLabel ?? parsed.payload?.element_id ?? "") as string;
      if (typeof componentLabel !== "string" || !componentLabel.trim()) {
        throw new Error("Missing component label");
      }
      const requestedLabel = normalizeLabel(componentLabel);
      const elements = api.current.getSceneElements();
      const textElement = elements.find((element) => {
        if (element.isDeleted) return false;
        if (element.id === componentLabel) return true;
        if (element.type !== "text") return false;
        const visibleLabel = normalizeLabel(element.originalText || element.text);
        return visibleLabel.length > 0 && (
          visibleLabel === requestedLabel ||
          visibleLabel.includes(requestedLabel) ||
          requestedLabel.includes(visibleLabel)
        );
      });
      if (!textElement) {
        throw new Error("Whiteboard component label was not found");
      }
      const selectedIds: Record<string, true> = { [textElement.id]: true };
      if (textElement.type === "text" && textElement.containerId) selectedIds[textElement.containerId] = true;
      const selectedElements = elements.filter((element) => selectedIds[element.id]);
      api.current.updateScene({
        appState: { selectedElementIds: selectedIds },
      });
      api.current.scrollToContent(selectedElements, {
        animate: true,
        fitToContent: true,
      });
      return JSON.stringify({ ok: true, componentLabel: textElement.type === "text" ? textElement.text : textElement.id });
    }, () => Boolean(api.current)));

  async function handleDone() {
    if (!api.current || isExporting || submitted) return;
    const elements = api.current.getSceneElements();
    if (!elements.length) {
      toast.warning("Draw something on the whiteboard first.");
      return;
    }

    setIsExporting(true);
    try {
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements,
        appState: {
          ...api.current.getAppState(),
          exportBackground: true,
          exportEmbedScene: false,
          exportWithDarkMode: false,
          viewBackgroundColor: "#ffffff",
        },
        files: api.current.getFiles(),
        maxWidthOrHeight: 2048,
        mimeType: "image/png",
      });
      if (blob.size > 4 * 1024 * 1024) {
        toast.error("The whiteboard image is over 4 MB. Simplify it and try again.");
        return;
      }
      const imageSha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
      ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (await onSubmit({ blob, imageSha256 })) {
        setSubmittedQuestion(question);
        toast.success("Drawing submitted.");
      }
    } catch (error) {
      console.error("Failed to submit whiteboard:", error);
      toast.error("Could not submit the whiteboard. Please try again.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-night">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate pr-3 text-sm text-foreground">{question}</p>
        <button
          type="button"
          onClick={() => void handleDone()}
          disabled={isExporting || submitted}
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitted ? "Submitted ✓" : isExporting ? "Submitting…" : "Submit diagram"}
        </button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <Excalidraw
          excalidrawAPI={(instance: ExcalidrawImperativeAPI) => {
            api.current = instance;
            instance.updateScene({ elements: [] });
          }}
          initialData={{ elements: [] }}
          onChange={(elements) => {
            const revision = elements
              .map((element) => `${element.id}:${element.version}:${element.isDeleted}`)
              .join("|");
            if (revision === sceneRevisionRef.current) return;
            sceneRevisionRef.current = revision;
            onContentChange?.();
          }}
          theme="dark"
          viewModeEnabled={submitted}
        />
      </div>
    </div>
  );
}
