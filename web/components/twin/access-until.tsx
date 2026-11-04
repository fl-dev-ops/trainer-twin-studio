"use client";

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/** A twin assignment's end date: "Until 30 Nov 2026", "Access ended" once past, or `none` when there is no end date. */
export function AccessUntil({ until, none = null }: { until: string | null; none?: ReactNode }) {
  // The clock is read once per mount (render must stay pure); a page left open past the date updates on its next load.
  const [now] = useState(() => Date.now());
  if (!until) return none;
  const end = new Date(until);
  if (end.getTime() <= now) return <Badge variant="error">Access ended</Badge>;
  return <span>Until {end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>;
}
