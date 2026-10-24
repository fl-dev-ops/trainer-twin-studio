"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

function format(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?([ap])m/i, " $1m").toLowerCase();
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/** "Today, 2:14 pm" in the viewer's own time zone (the server does not know it). */
export function SessionWhen({ iso }: { iso: string }) {
  const browser = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return <time dateTime={iso}>{browser ? format(iso) : new Date(iso).toISOString().slice(0, 10)}</time>;
}
