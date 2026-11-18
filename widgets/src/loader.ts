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
.floating { position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; }
button { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 52px; font: inherit; font-weight: 500; color: #f2eee5; background: #1b1c19; border: 1px solid #ffffff30; border-radius: 999px; padding: 12px 20px; cursor: pointer; box-shadow: 0 8px 24px #0003; transition: background .2s, transform .2s; }
button:hover { background: #2a2c26; transform: translateY(-2px); }
button:focus-visible { outline: 2px solid #8ca575; outline-offset: 4px; }
button svg { width: 20px; height: 20px; flex-shrink: 0; }
button[data-active="true"]::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #b5cf98; animation: pulse 2s ease-in-out infinite; }
.panel { width: min(400px, calc(100vw - 32px)); height: min(700px, calc(100dvh - 112px)); margin-bottom: 12px; border-radius: 28px; overflow: hidden; background: #1b1c19; box-shadow: 0 24px 64px -12px #0006; }
.mobile .panel { width: calc(100vw - 32px); height: calc(100dvh - 112px); }
.inline { display: block; width: 100%; height: 700px; max-height: 100dvh; min-height: 280px; border-radius: 28px; overflow: hidden; background: #1b1c19; }
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
      if (mode !== "floating" && mode !== "inline") {
        throw new Error("TrainerTwin data-mode must be floating or inline.");
      }
      const url = embedUrl(script.src, script.dataset.twinId ?? "", window.location.origin);
      url.searchParams.set("mode", mode);
      const widgetOrigin = url.origin;
      const targetId = script.dataset.target;
      let target: HTMLElement | null = null;
      if (targetId !== undefined) {
        if (mode !== "inline" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(targetId)) {
          throw new Error("TrainerTwin data-target must be a simple element ID in inline mode.");
        }
        target = document.getElementById(targetId);
        if (!target) throw new Error(`TrainerTwin target "${targetId}" was not found.`);
      }
      const root = document.createElement("div");
      root.setAttribute("data-trainertwin-widget", "");
      const shadow = root.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = styles;
      if (script.nonce) style.nonce = script.nonce;
      const container = document.createElement("div");
      container.className = mode;
      const panel = document.createElement("div");
      panel.className = mode === "floating" ? "panel" : "inline";
      panel.setAttribute("role", mode === "floating" ? "dialog" : "region");
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
      if (mode === "floating") container.append(launcher, status);
      shadow.append(style, container);
      let destroyed = false;
      let ready = false;
      let opened = mode === "inline";
      panel.hidden = !opened;
      const mobile = window.matchMedia("(max-width: 480px)");
      const resize = () => container.classList.toggle("mobile", mobile.matches);
      resize();
      mobile.addEventListener("change", resize);
      const send = (type: HostMessage["type"]) => {
        const message: HostMessage = { source: "trainertwin-host", version: 1, type };
        iframe.contentWindow?.postMessage(message, widgetOrigin);
      };
      const handle: WidgetHandle = {
        open() {
          if (destroyed || mode === "inline") return;
          opened = true;
          panel.hidden = false;
          launcher.setAttribute("aria-expanded", "true");
          if (ready) iframe.focus();
        },
        minimise() {
          if (destroyed || mode === "inline") return;
          opened = false;
          panel.hidden = true;
          launcher.setAttribute("aria-expanded", "false");
          launcher.focus();
        },
        destroy() {
          if (destroyed) return;
          send("destroy");
          destroyed = true;
          window.removeEventListener("message", onMessage);
          window.removeEventListener("keydown", onKey);
          mobile.removeEventListener("change", resize);
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
          if (opened && mode === "floating") iframe.focus();
        } else if (event.data.type === "close") {
          handle.minimise();
        } else {
          status.textContent = event.data.active ? "AI twin call in progress" : "AI twin call ended";
          launcherLabel.textContent = event.data.active ? "Call in progress" : "Talk to AI twin";
          launcher.dataset.active = String(event.data.active);
          launcher.setAttribute("aria-label", event.data.active ? "AI twin call in progress — reopen" : "Talk to AI twin");
        }
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape" && opened && mode === "floating") {
          event.preventDefault();
          handle.minimise();
        }
      };
      const toggle = () => opened ? handle.minimise() : handle.open();
      launcher.addEventListener("click", toggle);
      window.addEventListener("message", onMessage);
      window.addEventListener("keydown", onKey);
      if (mode === "floating") {
        (document.body ?? document.documentElement).append(root);
      } else if (target) {
        target.append(root);
      } else {
        script.after(root);
      }
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
