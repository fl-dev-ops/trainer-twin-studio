"use client";

import { useEffect, useState } from "react";
import { useVoiceAssistant } from "@livekit/components-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

export function LiveSubtitles({
  text,
  visible,
  className,
}: {
  text: string;
  visible: boolean;
  className?: string;
}) {
  const voiceAssistant = useVoiceAssistant();

  const latestAgentSegment = voiceAssistant.agentTranscriptions?.length
    ? voiceAssistant.agentTranscriptions[voiceAssistant.agentTranscriptions.length - 1]?.text
    : "";

  const [currentText, setCurrentText] = useState("");

  useEffect(() => {
    // Prefer the live streaming segment while the agent speaks; otherwise keep the
    // last finalized turn on screen so the candidate can still read the question.
    const active = latestAgentSegment || text;
    if (active) {
      setCurrentText(active);
    }
  }, [latestAgentSegment, text]);

  const shouldShow = visible && Boolean(currentText.trim());

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className={cn(
            "pointer-events-none absolute bottom-6 left-1/2 z-30 max-w-[min(720px,85%)] -translate-x-1/2 text-center",
            className,
          )}
        >
          <div className="inline-block rounded-md bg-black/85 px-3.5 py-1.5 shadow-elevation-3 backdrop-blur-md">
            <p className="text-body-s sm:text-body font-medium leading-relaxed tracking-wide text-white text-shadow-subtitle">
              {currentText}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
