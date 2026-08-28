"use client";

import { MicOff, UserRound } from "lucide-react";
import { motion } from "motion/react";
import { VisualizerBar } from "./visualizer-bar";

export function CandidateTile({
  level,
  micOn,
  compact = false,
}: {
  level?: number;
  micOn: boolean;
  compact?: boolean;
}) {
  return (
    <div className="session-tile relative flex h-full flex-col items-center justify-center overflow-hidden">
      <motion.div
        layout
        animate={{ width: compact ? 48 : 96, height: compact ? 48 : 96 }}
        transition={{ type: "spring", stiffness: 300, damping: 32, mass: 0.8 }}
        className="flex shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground shadow-[0_0_0_1px_var(--border)]"
      >
        {micOn ? (
          <UserRound aria-hidden="true" className={compact ? "size-5" : "size-10"} strokeWidth={1.6} />
        ) : (
          <MicOff aria-hidden="true" className={compact ? "size-5" : "size-10"} strokeWidth={1.6} />
        )}
      </motion.div>
      {!compact && (
        <div className={micOn ? "mt-3 text-muted-foreground" : "mt-3 text-destructive"}>
          <VisualizerBar state={micOn ? "listening" : "muted"} level={level} barCount={5} />
        </div>
      )}
      <div className="absolute bottom-3 left-4 rounded-md bg-background/80 px-2 py-1 text-xs font-medium text-foreground shadow-[0_0_0_1px_var(--border)] backdrop-blur-sm">
        You
      </div>
    </div>
  );
}
