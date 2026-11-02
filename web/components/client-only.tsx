"use client";

import { Suspense, useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};

/**
 * Renders `children` only in the browser: the server (and the hydration pass) render `fallback`. Pages under it never
 * render to HTML, so they can use window, media devices and browser-only data loading (useApi) freely.
 */
export function ClientOnly({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return mounted ? <Suspense fallback={fallback}>{children}</Suspense> : fallback;
}
