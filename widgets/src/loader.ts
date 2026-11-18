import { embedUrl, isWidgetMessage, type HostMessage } from "./protocol";

export interface WidgetHandle {
  open(): void;
  minimise(): void;
  destroy(): void;
}

export interface WidgetsAPI {
  mount(options: { script: HTMLScriptElement }): WidgetHandle;
  destroy(script: HTMLScriptElement): void;
}

declare global {
  interface Window {
    TrainerTwinWidgets?: WidgetsAPI;
  }
}

const styles = `
:host { all: initial; color-scheme: dark; font: 14px/1.4 system-ui, sans-serif; }
* { box-sizing: border-box; }
.floating { --panel-width: min(400px, calc(100vw - max(16px, env(safe-area-inset-left)) - max(16px, env(safe-area-inset-right)))); --panel-height: min(580px, calc(100dvh - max(16px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom)))); position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483000; width: var(--launcher-width, 180px); height: 52px; overflow: hidden; border-radius: 999px; background: #1b1c19; box-shadow: 0 8px 24px #0003; transition: width .6s cubic-bezier(.22,1,.36,1), height .6s cubic-bezier(.22,1,.36,1), border-radius .6s; }
.floating[data-open="true"] { width: var(--panel-width); height: var(--panel-height); border-radius: 28px; box-shadow: 0 24px 64px -12px #0006; transition-duration: .35s; }
.floating:has(> button:focus-visible) { outline: 2px solid #8ca575; outline-offset: 4px; }
button { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 52px; font: inherit; font-weight: 500; color: #f2eee5; background: #1b1c19; border: 1px solid #ffffff30; border-radius: 999px; padding: 12px 20px; cursor: pointer; box-shadow: 0 8px 24px #0003; transition: background .2s, transform .2s; }
button { position: absolute; bottom: 0; right: 0; white-space: nowrap; height: 52px; }
button:hover { background: #2a2c26; }
.floating[data-open="true"] > button { opacity: 0; visibility: hidden; pointer-events: none; }
button:focus-visible { outline: 2px solid #8ca575; outline-offset: 4px; }
button svg { width: 20px; height: 20px; flex-shrink: 0; }
button[data-active="true"]::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #b5cf98; animation: pulse 2s ease-in-out infinite; }
.panel { position: absolute; bottom: 0; right: 0; width: var(--panel-width); height: var(--panel-height); border-radius: 28px; overflow: hidden; background: #1b1c19; visibility: hidden; opacity: 0; transition: opacity .2s, visibility 0s .6s; }
.floating[data-open="true"] .panel { visibility: visible; opacity: 1; transition-delay: 0s; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
[hidden] { display: none !important; }
.status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes pulse { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

function createAPI(): WidgetsAPI {
  const mounts = new WeakMap<HTMLScriptElement, WidgetHandle>();

  return {
    mount({ script }) {
      const existing = mounts.get(script);
      if (existing) return existing;
      if (!(script instanceof HTMLScriptElement) || script.ownerDocument !== document) {
        throw new Error("TrainerTwin mount requires a script in the current document.");
      }
      const mode = script.dataset.mode ?? "floating";
      if (mode !== "floating") {
        throw new Error("TrainerTwin supports floating widgets only.");
      }
      const url = embedUrl(script.src, script.dataset.twinId ?? "", window.location.origin);
      url.searchParams.set("mode", mode);
      const widgetOrigin = url.origin;
      if (script.dataset.target !== undefined) throw new Error("Floating widgets do not support data-target.");
      const root = document.createElement("div");
      root.setAttribute("data-trainertwin-widget", "");
      const shadow = root.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = styles;
      if (script.nonce) style.nonce = script.nonce;
      const container = document.createElement("div");
      container.className = "floating";
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "AI twin conversation");
      const iframe = document.createElement("iframe");
      iframe.title = "Talk to AI twin";
      iframe.allow = `microphone ${widgetOrigin}`;
      iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
      iframe.referrerPolicy = "no-referrer";
      iframe.src = url.href;
      panel.append(iframe);
      const launcher = document.createElement("button");
      launcher.type = "button";
      const phone = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      phone.setAttribute("viewBox", "0 0 24 24");
      phone.setAttribute("fill", "none");
      phone.setAttribute("stroke", "currentColor");
      phone.setAttribute("stroke-width", "1.7");
      phone.setAttribute("stroke-linecap", "round");
      phone.setAttribute("stroke-linejoin", "round");
      phone.setAttribute("aria-hidden", "true");
      const phonePath = document.createElementNS(phone.namespaceURI, "path");
      phonePath.setAttribute("d", "M5 3h3l2 5-2 2a14 14 0 0 0 6 6l2-2 5 2v3a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2Z");
      phone.append(phonePath);
      const launcherLabel = document.createElement("span");
      launcherLabel.textContent = "Talk to AI twin";
      launcher.append(phone, launcherLabel);
      launcher.setAttribute("aria-label", "Talk to AI twin");
      launcher.setAttribute("aria-expanded", "false");
      launcher.setAttribute("aria-haspopup", "dialog");
      const status = document.createElement("span");
      status.className = "status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      container.append(panel);
      container.append(launcher, status);
      shadow.append(style, container);
      let destroyed = false;
      let ready = false;
      let opened = false;
      let hovered = false;
      let editing = false;
      let pinned = false;
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const hover = window.matchMedia("(hover: hover) and (pointer: fine)");
      panel.inert = true;
      panel.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      const send = (type: HostMessage["type"]) => {
        const message: HostMessage = { source: "trainertwin-host", version: 1, type };
        iframe.contentWindow?.postMessage(message, widgetOrigin);
      };
      const cancelExit = () => {
        if (exitTimer !== undefined) clearTimeout(exitTimer);
        exitTimer = undefined;
      };
      const expand = (focus: boolean) => {
          if (destroyed) return;
          cancelExit();
          opened = true;
          container.dataset.open = "true";
          panel.inert = false;
          panel.setAttribute("aria-hidden", "false");
          iframe.tabIndex = 0;
          launcher.inert = true;
          launcher.setAttribute("aria-expanded", "true");
          if (focus && ready) iframe.focus();
      };
      const collapse = (focus: boolean) => {
          if (destroyed) return;
          cancelExit();
          opened = false;
          pinned = false;
          editing = false;
          container.dataset.open = "false";
          panel.inert = true;
          panel.setAttribute("aria-hidden", "true");
          iframe.tabIndex = -1;
          launcher.inert = false;
          launcher.setAttribute("aria-expanded", "false");
          if (focus) launcher.focus();
      };
      const scheduleExit = () => {
        cancelExit();
        if (!opened || hovered || editing || pinned) return;
        exitTimer = setTimeout(() => {
          if (!hovered && !editing && !pinned) collapse(false);
        }, 350);
      };
      const onEnter = (event: PointerEvent) => {
        if (!hover.matches || event.pointerType !== "mouse") return;
        hovered = true;
        expand(false);
      };
      const onLeave = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        hovered = false;
        scheduleExit();
      };
      const handle: WidgetHandle = {
        open() { pinned = true; expand(true); },
        minimise() { collapse(true); },
        destroy() {
          if (destroyed) return;
          cancelExit();
          send("destroy");
          destroyed = true;
          window.removeEventListener("message", onMessage);
          window.removeEventListener("keydown", onKey);
          container.removeEventListener("pointerenter", onEnter);
          container.removeEventListener("pointerleave", onLeave);
          launcher.removeEventListener("click", toggle);
          root.remove();
          mounts.delete(script);
        },
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.source !== iframe.contentWindow || event.origin !== widgetOrigin || !isWidgetMessage(event.data)) return;
        if (event.data.type === "ready") {
          ready = true;
          send("init");
          if (opened && pinned) iframe.focus();
        } else if (event.data.type === "close") {
          handle.minimise();
        } else if (event.data.type === "interaction") {
          editing = event.data.editing;
          if (editing) cancelExit();
          else scheduleExit();
        } else {
          status.textContent = event.data.active ? "AI twin call in progress" : "AI twin call ended";
          launcherLabel.textContent = event.data.active ? "Call in progress" : "Talk to AI twin";
          launcher.dataset.active = String(event.data.active);
          launcher.setAttribute("aria-label", event.data.active ? "AI twin call in progress — reopen" : "Talk to AI twin");
          container.style.setProperty("--launcher-width", `${Math.ceil(launcher.getBoundingClientRect().width)}px`);
        }
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape" && opened) {
          event.preventDefault();
          handle.minimise();
        }
      };
      const toggle = () => opened ? handle.minimise() : handle.open();
      launcher.addEventListener("click", toggle);
      container.addEventListener("pointerenter", onEnter);
      container.addEventListener("pointerleave", onLeave);
      window.addEventListener("message", onMessage);
      window.addEventListener("keydown", onKey);
      (document.body ?? document.documentElement).append(root);
      container.style.setProperty("--launcher-width", `${Math.ceil(launcher.getBoundingClientRect().width)}px`);
      mounts.set(script, handle);
      return handle;
    },
    destroy(script) {
      mounts.get(script)?.destroy();
    },
  };
}

const script = document.currentScript;
if (script instanceof HTMLScriptElement) {
  const api = window.TrainerTwinWidgets ??= createAPI();
  api.mount({ script });
}
