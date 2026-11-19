import { createElement, Phone } from "lucide";
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
:host { all: initial; color-scheme: dark; font: 14px/1.4 system-ui, sans-serif; }
* { box-sizing: border-box; }
.floating { --panel-width: min(340px, calc(100vw - max(16px, env(safe-area-inset-left)) - max(16px, env(safe-area-inset-right)))); --panel-height: min(var(--content-height, 100dvh), calc(100dvh - max(16px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom)))); position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483000; width: 48px; height: 48px; overflow: hidden; border-radius: 50%; background: #0d0d0b; box-shadow: 0 10px 28px -12px #0009; transition: width .6s cubic-bezier(.4,0,.2,1), height .6s cubic-bezier(.4,0,.2,1), border-radius .6s; }
.floating[data-open="true"] { width: var(--panel-width); height: var(--panel-height); border-radius: 28px; box-shadow: 0 24px 64px -12px #0006; transition-duration: .35s; transition-timing-function: cubic-bezier(.22,1,.36,1); }
.floating:has(> button:focus-visible) { outline: 2px solid #8ca575; outline-offset: 4px; }
button { position: absolute; bottom: 0; right: 0; display: grid; place-items: center; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #f2eee5; cursor: pointer; opacity: 1; visibility: visible; transition: background .2s, opacity .18s .2s, visibility 0s; }
button:active svg { transform: scale(.9); }
button:hover { background: #2a2c26; }
.floating[data-open="true"] > button { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .1s, visibility 0s .1s; }
button:focus-visible { outline: 2px solid #8ca575; outline-offset: 4px; }
button svg { width: 20px; height: 20px; flex-shrink: 0; }
.panel { position: absolute; bottom: 0; right: 0; width: var(--panel-width); height: var(--panel-height); border-radius: 28px; overflow: hidden; background: #1b1c19; visibility: hidden; pointer-events: none; transition: visibility 0s .6s; }
.floating[data-open="true"] .panel { visibility: visible; transition-delay: 0s; }
.floating[data-open="true"] .panel[data-interactive="true"] { pointer-events: auto; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
[hidden] { display: none !important; }
.status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
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
      const phone = createElement(Phone, { "aria-hidden": "true", focusable: "false", "stroke-width": 1.75 });
      launcher.append(phone);
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
      let active = false;
      let focusOnOpen = false;
      panel.inert = true;
      panel.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      const send = (type: HostMessage["type"], open = false) => {
        const message: HostMessage = type === "visibility"
          ? { source: "trainertwin-host", version: 1, type, open }
          : { source: "trainertwin-host", version: 1, type };
        iframe.contentWindow?.postMessage(message, widgetOrigin);
      };
      const enablePanel = () => {
        if (destroyed || !opened) return;
        panel.inert = false;
        panel.dataset.interactive = "true";
        iframe.tabIndex = 0;
        if (ready && focusOnOpen) iframe.focus();
      };
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target === container && event.propertyName === "height"
          && (event.type === "transitionend" || window.matchMedia("(prefers-reduced-motion: reduce)").matches)) enablePanel();
      };
      const expand = (focus = true) => {
          if (destroyed || opened) return;
          focusOnOpen = focus;
          opened = true;
          container.dataset.open = "true";
          panel.setAttribute("aria-hidden", "false");
          launcher.inert = true;
          launcher.setAttribute("aria-expanded", "true");
          if (ready) send("visibility", true);
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches
            || Math.abs(container.getBoundingClientRect().height - panel.offsetHeight) < 1) enablePanel();
      };
      const collapse = (focus: boolean) => {
          if (destroyed || active) return;
          opened = false;
          container.dataset.open = "false";
          panel.inert = true;
          panel.dataset.interactive = "false";
          panel.setAttribute("aria-hidden", "true");
          iframe.tabIndex = -1;
          launcher.inert = false;
          launcher.setAttribute("aria-expanded", "false");
          if (ready) send("visibility", false);
          if (focus) launcher.focus();
      };
      const handle: WidgetHandle = {
        open: expand,
        minimise() { collapse(true); },
        destroy() {
          if (destroyed) return;
          send("destroy");
          destroyed = true;
          window.removeEventListener("message", onMessage);
          window.removeEventListener("keydown", onKey);
          container.removeEventListener("transitionend", onTransitionEnd);
          container.removeEventListener("transitioncancel", onTransitionEnd);
          launcher.removeEventListener("click", toggle);
          root.remove();
          mounts.delete(script);
        },
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.source !== iframe.contentWindow || event.origin !== widgetOrigin || !isWidgetMessage(event.data)) return;
        if (event.data.type === "ready") {
          const showIntro = !ready && !opened && event.data.intro;
          ready = true;
          send("init");
          if (showIntro) expand(false);
          else send("visibility", opened);
          if (opened && focusOnOpen && !panel.inert) iframe.focus();
        } else if (event.data.type === "close") {
          handle.minimise();
        } else if (event.data.type === "resize") {
          container.style.setProperty("--content-height", `${Math.min(MAX_WIDGET_HEIGHT, event.data.height)}px`);
        } else if (event.data.type === "status") {
          active = event.data.active;
          if (active) expand(false);
          status.textContent = active ? "AI twin call in progress" : "AI twin call ended";
        }
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape" && opened) {
          event.preventDefault();
          handle.minimise();
        }
      };
      const toggle = () => expand();
      launcher.addEventListener("click", toggle);
      container.addEventListener("transitionend", onTransitionEnd);
      container.addEventListener("transitioncancel", onTransitionEnd);
      window.addEventListener("message", onMessage);
      window.addEventListener("keydown", onKey);
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
