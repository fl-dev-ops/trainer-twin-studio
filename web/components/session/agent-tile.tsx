"use client";

import Image from "next/image";
import { UserRound } from "lucide-react";
import { motion } from "motion/react";
import { VisualizerBar, type VisualizerState } from "./visualizer-bar";
import { cn } from "@/lib/utils";

const STATE_LABELS: Record<VisualizerState, string> = {
  connecting: "Joining…",
  thinking: "Thinking…",
  listening: "Listening",
  speaking: "Speaking",
  muted: "Ready",
};

export function AgentTile({
  persona,
  state,
  level,
  compact = false,
}: {
  persona: string;
  state: VisualizerState;
  level?: number;
  compact?: boolean;
}) {
  const name = persona.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return (
    <div className="session-tile relative flex h-full flex-col items-center justify-center overflow-hidden">
      <motion.div
        layout
        animate={{ width: compact ? 48 : 128, height: compact ? 48 : 128 }}
        transition={{ type: "spring", stiffness: 300, damping: 32, mass: 0.8 }}
        className="relative shrink-0 overflow-hidden rounded-full bg-accent shadow-[0_0_0_1px_var(--border),0_0_44px_color-mix(in_oklab,var(--primary)_14%,transparent)]"
      >
        {persona === "vasanth" ? (
          <Image src="/vasanth.png" alt="" fill sizes={compact ? "48px" : "128px"} className="object-cover" />
        ) : (
          <UserRound aria-hidden="true" className="absolute inset-1/4 size-1/2 text-muted-foreground" strokeWidth={1.5} />
        )}
      </motion.div>
      <motion.div
        layout
        animate={{ marginTop: compact ? 6 : 16 }}
        transition={{ type: "spring", stiffness: 300, damping: 32, mass: 0.8 }}
        className={cn("w-full text-primary", compact && "scale-90")}
      >
        <VisualizerBar state={state} level={level} barCount={compact ? 3 : 5} />
      </motion.div>
      <div className="absolute bottom-3 left-4 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{name || "Trainer"}</span>
        <span aria-hidden="true" className="size-1 rounded-full bg-border" />
        <span>{STATE_LABELS[state] ?? state}</span>
      </div>
    </div>
  );
}
