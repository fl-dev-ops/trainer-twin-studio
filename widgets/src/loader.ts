import { embedUrl, isWidgetMessage, MAX_WIDGET_HEIGHT, type HostMessage } from "./protocol";

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
:host {
  all: initial !important;
  display: contents !important;
  direction: ltr !important;
  unicode-bidi: isolate !important;
  color-scheme: dark !important;
  font: 14px/1.4 system-ui, sans-serif !important;
}
* { box-sizing: border-box; }
.floating { --content-height: 100dvh; --panel-width: min(340px, calc(100vw - max(16px, env(safe-area-inset-left)) - max(16px, env(safe-area-inset-right)))); --panel-height: min(var(--content-height, 100dvh), calc(100dvh - max(16px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom)))); position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483000; width: var(--panel-width); height: var(--panel-height); overflow: hidden; border-radius: 28px; background: transparent; box-shadow: 0 24px 64px -12px #0006; opacity: 0; visibility: hidden; transform: translateY(12px); transition: opacity .3s ease, transform .45s cubic-bezier(.22,1,.36,1), visibility 0s .45s; }
.floating[data-shown="true"] { opacity: 1; visibility: visible; transform: none; transition: opacity .3s ease, transform .45s cubic-bezier(.22,1,.36,1), visibility 0s, height .35s cubic-bezier(.22,1,.36,1); }
.panel { position: absolute; bottom: 0; right: 0; width: var(--panel-width); height: var(--panel-height); border-radius: 28px; overflow: hidden; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
[hidden] { display: none !important; }
.status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

/** Show the card anyway if the hosted page never reports its height. */
const SHOW_FALLBACK_MS = 2000;

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
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "AI twin conversation");
      const iframe = document.createElement("iframe");
      iframe.title = "Talk to AI twin";
      iframe.allow = `microphone ${widgetOrigin}`;
      iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms");
      iframe.referrerPolicy = "no-referrer";
      iframe.src = url.href;
      panel.append(iframe);
      const status = document.createElement("span");
      status.className = "status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      container.append(panel, status);
      shadow.append(style, container);
      // There is no collapsed launcher: the intro card is the resting state. It stays invisible until the hosted
      // page has reported its height, so it appears once at the right size instead of growing from a placeholder.
      let destroyed = false;
      let ready = false;
      let shown = false;
      let active = false;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const send = (type: HostMessage["type"], open = false) => {
        const message: HostMessage = type === "visibility"
          ? { source: "trainertwin-host", version: 1, type, open }
          : { source: "trainertwin-host", version: 1, type };
        iframe.contentWindow?.postMessage(message, widgetOrigin);
      };
      const show = () => {
        if (destroyed || shown || !ready) return;
        shown = true;
        clearTimeout(fallback);
        void container.offsetHeight; // commit the measured height before enabling the height transition
        container.dataset.shown = "true";
        send("visibility", true);
      };
      const reset = () => {
        if (destroyed || !ready || active) return;
        send("reset");
      };
      const handle: WidgetHandle = {
        open() {
          if (shown) iframe.focus();
        },
        minimise: reset,
        destroy() {
          if (destroyed) return;
          send("destroy");
          destroyed = true;
          clearTimeout(fallback);
          window.removeEventListener("message", onMessage);
          window.removeEventListener("keydown", onKey);
          document.removeEventListener("pointerdown", onOutside, true);
          root.remove();
          mounts.delete(script);
        },
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.source !== iframe.contentWindow || event.origin !== widgetOrigin || !isWidgetMessage(event.data)) return;
        if (event.data.type === "ready") {
          ready = true;
          send("init");
          if (shown) send("visibility", true);
          else fallback ??= setTimeout(show, SHOW_FALLBACK_MS);
        } else if (event.data.type === "resize") {
          container.style.setProperty("--content-height", `${Math.min(MAX_WIDGET_HEIGHT, event.data.height)}px`);
          show();
        } else if (event.data.type === "status") {
          active = event.data.active;
          status.textContent = active ? "AI twin call in progress" : "AI twin call ended";
        }
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape" && shown && !active) reset();
      };
      const onOutside = (event: PointerEvent) => {
        if (shown && !event.composedPath().includes(root)) reset();
      };
      window.addEventListener("message", onMessage);
      window.addEventListener("keydown", onKey);
      document.addEventListener("pointerdown", onOutside, true);
      (document.body ?? document.documentElement).append(root);
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
