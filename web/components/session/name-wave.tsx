import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

const colors = {
  speaking: "bg-success-border dark:bg-success",
  thinking: "bg-brand",
};

export function NameWave({ tone }: { tone: keyof typeof colors | "listening" }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {tone !== "listening" && (
        <motion.span
          key="wave"
          aria-hidden
          className="flex shrink-0 overflow-hidden"
          initial={reduceMotion ? false : { width: 0, opacity: 0 }}
          animate={{ width: "auto", opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
        >
          <span className="flex h-3.5 shrink-0 items-center gap-0.5 pr-2">
            {["h-1.5", "h-3", "h-3.5", "h-3", "h-1.5"].map((height, index) => (
              <span
                key={index}
                className={cn(
                  "w-0.5 origin-center rounded-full motion-safe:animate-participant-wave",
                  height,
                  colors[tone],
                )}
              />
            ))}
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
