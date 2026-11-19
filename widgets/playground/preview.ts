import { mount, parseConfig, type WidgetPreview } from "../src/widget";

const states = new Map<string, WidgetPreview>([
  ["name", { phase: "ready" }],
  ["call", { phase: "live", agentState: "speaking", name: "Jordan" }],
  ["exhausted", { phase: "exhausted" }],
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
