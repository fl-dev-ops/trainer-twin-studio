"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type VisualizerState = "connecting" | "thinking" | "listening" | "speaking" | "muted";

const SEQUENCE_INTERVAL: Record<VisualizerState, number> = {
  connecting: 400,
  thinking: 140,
  listening: 500,
  speaking: 1000,
  muted: 1000,
};

/**
 * Bar visualizer driven by a single 0–1 audio level plus a state machine.
 * ponytail: one level distributed over bars with fixed weights; multiband
 * WebAudio analysis only if fidelity actually matters.
 */
export function VisualizerBar({
  state,
  level = 0,
  barCount = 5,
  className,
}: {
  state: VisualizerState;
  level?: number;
  barCount?: number;
  className?: string;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (state === "speaking") return;
    const interval = setInterval(() => setTick((value) => value + 1), SEQUENCE_INTERVAL[state]);
    return () => clearInterval(interval);
  }, [state]);

  const heights = useMemo(() => {
    if (state === "speaking") {
      // fixed weights fan the single level into a bar-like shape
      const weights = [0.55, 0.85, 1, 0.8, 0.6, 0.9, 0.7].slice(0, barCount);
      return weights.map((weight, index) => {
        const boost = ((tick + index * 2) % 3) * 0.08;
        return Math.min(1, Math.max(0.12, level * 1.6 * weight + boost + 0.08));
      });
    }
    if (state === "muted") return new Array(barCount).fill(0.1);
    // idle sequencing: light the bars in a slow rotating pattern
    const active = tick % barCount;
    const spread = state === "thinking" ? 2 : 1;
    return Array.from({ length: barCount }, (_, index) => {
      const distance = Math.min(Math.abs(index - active), barCount - Math.abs(index - active));
      return distance <= spread ? 0.75 - distance * 0.22 : 0.16;
    });
  }, [state, level, barCount, tick]);

  return (
    <div
      data-state={state}
      aria-hidden="true"
      className={cn("flex h-8 items-center justify-center gap-1", className)}
    >
      {heights.map((height, index) => (
        <div
          key={index}
          className="w-1 min-h-1 rounded-full bg-current/25 transition-[height,background-color] duration-150 ease-linear data-[highlighted=true]:bg-current"
          data-highlighted={state !== "muted" && height > 0.4}
          style={{ height: `${Math.round(height * 100)}%` }}
        />
      ))}
    </div>
  );
}
