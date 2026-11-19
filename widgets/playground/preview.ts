import { mount, parseConfig, type WidgetPreview } from "../src/widget";

const states = new Map<string, WidgetPreview>([
  ["ready", { phase: "ready" }],
  ["returning", { phase: "ready", name: "Jordan" }],
  ["connecting", { phase: "connecting" }],
  ["listening", { phase: "live", agentState: "listening" }],
  ["thinking", { phase: "live", agentState: "thinking" }],
  ["speaking", { phase: "live", agentState: "speaking" }],
  ["muted", { phase: "live", muted: true }],
  ["reconnecting", { phase: "live", reconnecting: true }],
  ["time-low", { phase: "live", urgent: true }],
  ["ended", { phase: "ended" }],
  ["failed", { phase: "failed" }],
]);

const root = document.getElementById("preview-widget");
if (!root) throw new Error("Missing widget preview root");
root.id = "trainertwin-widget";
const state = new URL(location.href).searchParams.get("state");
const embedded = location.pathname === "/embed/preview";
mount(root, parseConfig({
  agentId: "preview", parentOrigin: location.origin, name: "Practice Coach", trainerName: "Vasanth",
  photoUrl: new URL("/preview/portrait", location.origin).href,
  welcome: "Talk to my AI twin", accentColor: "#111111", maxSeconds: 180, livekitUrl: "ws://localhost",
}), { ...(states.get(state ?? "") ?? { phase: "ready" }), embedded });
