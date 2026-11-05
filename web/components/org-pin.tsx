"use client";

import { ORG_PIN_HEADER } from "@/lib/org-pin";

let pinned: string | null = null;
let installed = false;

/**
 * Adds the pinned org to this tab's same-origin fetches: /api (tRPC and plain fetch alike) and the server-rendered
 * parts of client-side navigations. Full page loads don't go through fetch; they use the session's active org.
 */
function install() {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!pinned || url.origin !== window.location.origin) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(ORG_PIN_HEADER)) headers.set(ORG_PIN_HEADER, pinned);
    return original(input, { ...init, headers });
  };
}

/**
 * Pins this tab to the org its page was loaded in (lib/org-pin.ts). Set while rendering, before the pages below it
 * render and load data, so their first request already carries it.
 */
export function OrgPin({ orgId }: { orgId: string | null }) {
  if (typeof window !== "undefined") {
    install();
    pinned = orgId;
  }
  return null;
}
