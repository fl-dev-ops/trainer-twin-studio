"use client";

import { useSyncExternalStore } from "react";

const DAY = 24 * 60 * 60 * 1000;

/** "Today, 2:14 pm" / "Yesterday, 11:02 am" / "Mon, 10:05 am" / "12 Oct, 3:30 pm", in the viewer's timezone. */
export function formatSessionTime(date: Date, now = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = date.getTime();
  if (at >= startOfToday) return `Today, ${time}`;
  if (at >= startOfToday - DAY) return `Yesterday, ${time}`;
  if (at >= startOfToday - 6 * DAY) return `${date.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return `${day}, ${time}`;
}

const noopSubscribe = () => () => {};

/** Formats on the client only: the server's timezone is not the viewer's. */
export function SessionTime({ iso }: { iso: string }) {
  const onClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return <time dateTime={iso}>{onClient ? formatSessionTime(new Date(iso)) : "\u00a0"}</time>;
}
