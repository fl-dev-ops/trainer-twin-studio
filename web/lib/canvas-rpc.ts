import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  newElementWith,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

export const CANVAS_RPC_METHOD = "workspace.canvas";
type Request = { action?: string; payload?: Record<string, unknown> };
type CanvasRpcContext = { api: ExcalidrawImperativeAPI | null };

function scene(api: ExcalidrawImperativeAPI) {
  return api.getSceneElements();
}

function summary(element: ReturnType<typeof scene>[number]) {
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    groupIds: element.groupIds,
    text: "text" in element ? element.text : undefined,
    containerId: "containerId" in element ? element.containerId : undefined,
    boundElements: element.boundElements,
  };
}

function update(api: ExcalidrawImperativeAPI, skeletons: ExcalidrawElementSkeleton[]) {
  const added = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  api.updateScene({ elements: [...scene(api), ...added], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  api.scrollToContent(added, { fitToContent: true });
  return added.map(({ id, type }) => ({ id, type }));
}

function ids(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.ids)) throw new Error("Element IDs are required");
  return payload.ids.map(String);
}

function point(element: ReturnType<typeof scene>[number]) {
  return { x: element.x + element.width / 2, y: element.y + element.height / 2 };
}

function composite(api: ExcalidrawImperativeAPI, skeletons: ExcalidrawElementSkeleton[]) {
  if (skeletons.length > 100) throw new Error("Composite diagrams are limited to 100 elements");
  return update(api, skeletons);
}

function duplicateSkeleton(
  element: ReturnType<typeof scene>[number],
  offsetX: number,
  offsetY: number,
): ExcalidrawElementSkeleton {
  const common = {
    x: element.x + offsetX,
    y: element.y + offsetY,
    width: element.width,
    height: element.height,
    angle: element.angle,
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    roughness: element.roughness,
    opacity: element.opacity,
  };
  if (element.type === "text") {
    return { type: "text", text: element.text, ...common };
  }
  if (element.type === "line" || element.type === "arrow") {
    const [originX, originY] = element.points[0];
    return {
      type: element.type,
      ...common,
      points: element.points.map(([x, y]) => [x - originX, y - originY]),
    } as ExcalidrawElementSkeleton;
  }
  if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
    return { type: element.type, ...common } as ExcalidrawElementSkeleton;
  }
  if (element.type === "image") {
    if (!element.fileId) throw new Error("Image file is missing");
    return { type: "image", fileId: element.fileId, ...common };
  }
  throw new Error(`Duplicating ${element.type} elements is not supported`);
}

export async function handleCanvasRpc(raw: string, context: CanvasRpcContext): Promise<string> {
  const request = JSON.parse(raw) as Request;
  const payload = request.payload ?? {};
  const api = context.api;
  if (!api) throw new Error("Canvas is not ready");

  switch (request.action) {
    case "get_scene":
      return JSON.stringify({ ok: true, result: scene(api).map(summary) });
    case "get_selection": {
      const selected = api.getAppState().selectedElementIds;
      return JSON.stringify({ ok: true, result: scene(api).filter((element) => selected[element.id]).map(summary) });
    }
    case "get_element": {
      const element = scene(api).find(({ id }) => id === String(payload.id));
      if (!element) throw new Error("Element not found");
      return JSON.stringify({ ok: true, result: summary(element) });
    }
    case "get_text":
      return JSON.stringify({ ok: true, result: scene(api).filter((element) => element.type === "text").map(summary) });
    case "get_viewport": {
      const { scrollX, scrollY, zoom, width, height } = api.getAppState();
      return JSON.stringify({ ok: true, result: { scrollX, scrollY, zoom: zoom.value, width, height } });
    }
    case "add_text":
      return JSON.stringify({ ok: true, result: update(api, [{ type: "text", text: String(payload.text ?? ""), x: Number(payload.x ?? 100), y: Number(payload.y ?? 100) }]) });
    case "add_shape": {
      const type = String(payload.type ?? "rectangle");
      if (!["rectangle", "ellipse", "diamond"].includes(type)) throw new Error("Unsupported shape");
      return JSON.stringify({ ok: true, result: update(api, [{ type: type as "rectangle" | "ellipse" | "diamond", x: Number(payload.x ?? 100), y: Number(payload.y ?? 100), width: Number(payload.width ?? 180), height: Number(payload.height ?? 100), label: typeof payload.label === "string" ? { text: payload.label } : undefined }]) });
    }
    case "add_arrow":
    case "add_line":
      return JSON.stringify({ ok: true, result: update(api, [{ type: request.action === "add_arrow" ? "arrow" : "line", x: Number(payload.x ?? 100), y: Number(payload.y ?? 100), points: Array.isArray(payload.points) ? payload.points as [[number, number], [number, number]] : [[0, 0], [160, 0]], label: typeof payload.label === "string" ? { text: payload.label } : undefined }]) });
    case "add_image": {
      const dataURL = String(payload.dataURL ?? "");
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataURL) || dataURL.length > 10_000) throw new Error("A valid image data URL under 10 KB is required");
      const fileId = crypto.randomUUID();
      const mimeType = dataURL.slice(5, dataURL.indexOf(";"));
      api.addFiles([{ id: fileId, dataURL, mimeType, created: Date.now() } as BinaryFileData]);
      return JSON.stringify({ ok: true, result: update(api, [{ type: "image", fileId: fileId as never, x: Number(payload.x ?? 100), y: Number(payload.y ?? 100), width: Number(payload.width ?? 320), height: Number(payload.height ?? 180) }]) });
    }
    case "add_system_component":
      return JSON.stringify({ ok: true, result: update(api, [{ type: "rectangle", x: Number(payload.x ?? 100), y: Number(payload.y ?? 100), width: Number(payload.width ?? 200), height: Number(payload.height ?? 100), roundness: { type: 3 }, backgroundColor: String(payload.backgroundColor ?? "#e7f5ff"), label: { text: String(payload.label ?? "Component") } } as ExcalidrawElementSkeleton]) });
    case "connect_elements": {
      const from = scene(api).find(({ id }) => id === String(payload.fromId));
      const to = scene(api).find(({ id }) => id === String(payload.toId));
      if (!from || !to) throw new Error("Connection elements not found");
      const start = point(from);
      const end = point(to);
      return JSON.stringify({ ok: true, result: update(api, [{ type: "arrow", x: start.x, y: start.y, points: [[0, 0], [end.x - start.x, end.y - start.y]], label: payload.label ? { text: String(payload.label) } : undefined }]) });
    }
    case "label_connection": {
      const connection = scene(api).find(({ id }) => id === String(payload.id));
      if (!connection || !["arrow", "line"].includes(connection.type)) throw new Error("Connection not found");
      const center = point(connection);
      return JSON.stringify({ ok: true, result: update(api, [{ type: "text", x: center.x, y: center.y, text: String(payload.label ?? "") }]) });
    }
    case "add_flowchart": {
      if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) throw new Error("Flowchart nodes and edges are required");
      const nodes = payload.nodes.map((node, index) => {
        const value = node as Record<string, unknown>;
        return { type: "rectangle", id: String(value.id ?? crypto.randomUUID()), x: Number(value.x ?? 100 + index * 220), y: Number(value.y ?? 100), width: Number(value.width ?? 170), height: Number(value.height ?? 80), label: { text: String(value.label ?? `Step ${index + 1}`) } } as ExcalidrawElementSkeleton;
      });
      const byId = new Map(nodes.map((node) => [String(node.id), node]));
      const edges = payload.edges.map((edge) => {
        const value = edge as Record<string, unknown>;
        const from = byId.get(String(value.from_node));
        const to = byId.get(String(value.to_node));
        if (!from || !to) throw new Error("Flowchart edge references an unknown node");
        const start = { x: Number(from.x) + Number(from.width) / 2, y: Number(from.y) + Number(from.height) / 2 };
        const end = { x: Number(to.x) + Number(to.width) / 2, y: Number(to.y) + Number(to.height) / 2 };
        return { type: "arrow", x: start.x, y: start.y, points: [[0, 0], [end.x - start.x, end.y - start.y]], label: value.label ? { text: String(value.label) } : undefined } as ExcalidrawElementSkeleton;
      });
      return JSON.stringify({ ok: true, result: composite(api, [...nodes, ...edges]) });
    }
    case "add_sequence": {
      if (!Array.isArray(payload.participants) || !Array.isArray(payload.messages)) throw new Error("Sequence participants and messages are required");
      const originX = Number(payload.x ?? 100);
      const originY = Number(payload.y ?? 100);
      const participants = payload.participants.map(String);
      const messages = payload.messages as Record<string, unknown>[];
      const positions = new Map(participants.map((name, index) => [name, originX + index * 220]));
      const skeletons: ExcalidrawElementSkeleton[] = participants.flatMap((name, index) => {
        const x = originX + index * 220;
        return [{ type: "rectangle", x, y: originY, width: 150, height: 50, label: { text: name } }, { type: "line", x: x + 75, y: originY + 50, points: [[0, 0], [0, Math.max(250, messages.length * 70)]] }] as ExcalidrawElementSkeleton[];
      });
      messages.forEach((message, index) => {
        const value = message as Record<string, unknown>;
        const fromX = positions.get(String(value.from));
        const toX = positions.get(String(value.to));
        if (fromX === undefined || toX === undefined) throw new Error("Sequence message references an unknown participant");
        skeletons.push({ type: "arrow", x: fromX + 75, y: originY + 100 + index * 70, points: [[0, 0], [toX - fromX, 0]], label: { text: String(value.label ?? "message") } });
      });
      return JSON.stringify({ ok: true, result: composite(api, skeletons) });
    }
    case "update_element": {
      const id = String(payload.id);
      const changes = payload.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Element changes are required");
      const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => ["x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "opacity", "text"].includes(key)));
      let found = false;
      const elements = scene(api).map((element) => {
        if (element.id !== id) return element;
        found = true;
        return newElementWith(element, allowed as never);
      });
      if (!found) throw new Error("Element not found");
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return JSON.stringify({ ok: true, result: { id } });
    }
    case "delete_elements": {
      const removing = new Set(ids(payload));
      const before = scene(api);
      api.updateScene({ elements: before.filter(({ id }) => !removing.has(id)), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return JSON.stringify({ ok: true, result: { deleted: before.length - scene(api).length } });
    }
    case "duplicate_elements": {
      const copying = new Set(ids(payload));
      const offsetX = Number(payload.offsetX ?? 30);
      const offsetY = Number(payload.offsetY ?? 30);
      const skeletons = scene(api)
        .filter(({ id }) => copying.has(id))
        .map((element) => duplicateSkeleton(element, offsetX, offsetY));
      return JSON.stringify({ ok: true, result: update(api, skeletons) });
    }
    case "group_elements": {
      const grouping = new Set(ids(payload));
      const groupId = crypto.randomUUID();
      api.updateScene({ elements: scene(api).map((element) => grouping.has(element.id) ? newElementWith(element, { groupIds: [...element.groupIds, groupId] } as never) : element), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return JSON.stringify({ ok: true, result: { groupId } });
    }
    case "clear": {
      const count = scene(api).length;
      api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return JSON.stringify({ ok: true, result: { cleared: count } });
    }
    case "select_elements":
    case "highlight_elements":
    case "scroll_to_elements": {
      const selectedIds = ids(payload);
      const elements = scene(api).filter(({ id }) => selectedIds.includes(id));
      if (request.action !== "scroll_to_elements") api.updateScene({ appState: { selectedElementIds: Object.fromEntries(selectedIds.map((id) => [id, true])) } });
      api.scrollToContent(elements, { fitToContent: true, animate: true });
      return JSON.stringify({ ok: true });
    }
    case "zoom_to_fit":
      api.scrollToContent(scene(api), { fitToViewport: true, viewportZoomFactor: 0.85, animate: true });
      return JSON.stringify({ ok: true });
    case "set_active_tool": {
      const tool = String(payload.tool);
      if (!["selection", "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "eraser", "hand"].includes(tool)) throw new Error("Unsupported canvas tool");
      api.setActiveTool({ type: tool as never });
      return JSON.stringify({ ok: true, result: { tool } });
    }
    case "clear_selection":
      api.updateScene({ appState: { selectedElementIds: {} } });
      return JSON.stringify({ ok: true });
    case "export_svg": {
      const svg = await exportToSvg({ elements: scene(api), appState: api.getAppState(), files: api.getFiles() });
      return JSON.stringify({ ok: true, result: { mimeType: "image/svg+xml", svg: svg.outerHTML } });
    }
    case "export_png": {
      const blob = await exportToBlob({ elements: scene(api), appState: api.getAppState(), files: api.getFiles(), mimeType: "image/png", maxWidthOrHeight: 1600 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const base64 = btoa(String.fromCharCode(...bytes));
      return JSON.stringify({ ok: true, result: { mimeType: blob.type, base64 } });
    }
    default:
      throw new Error(`Unsupported canvas action: ${String(request.action)}`);
  }
}
