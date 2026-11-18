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
:host { all: initial; color-scheme: light; font: 14px/1.4 system-ui, sans-serif; }
* { box-sizing: border-box; }
.floating { position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483000; }
button { font: inherit; color: #fff; background: #18181b; border: 1px solid #3f3f46; border-radius: 999px; padding: 16px 24px; cursor: pointer; box-shadow: 0 4px 16px #0002; }
button:focus-visible { outline: 3px solid #2563eb; outline-offset: 4px; }
.panel { width: min(400px, calc(100vw - 32px)); height: min(640px, calc(100dvh - 112px)); margin-bottom: 12px; border: 1px solid #e4e4e7; border-radius: 16px; overflow: hidden; background: white; box-shadow: 0 8px 32px #0003; }
.mobile .panel { width: calc(100vw - 32px); height: calc(100dvh - 112px); }
.inline { display: block; width: 100%; height: 640px; max-height: 100dvh; min-height: 280px; border: 1px solid #e4e4e7; border-radius: 16px; overflow: hidden; background: white; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
[hidden] { display: none !important; }
.status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
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
      launcher.textContent = "Talk to AI twin";
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
          launcher.textContent = event.data.active ? "Call in progress" : "Talk to AI twin";
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
