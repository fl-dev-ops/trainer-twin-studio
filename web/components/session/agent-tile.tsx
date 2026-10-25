"use client";

import Image from "next/image";
import { useVoiceAssistant } from "@livekit/components-react";
import { cn } from "@/lib/utils";

/** The trainer's tile (V2 prototype): photo or initial on the light wash, a status pill and a name tag. */
export function AgentTile({ persona, compact = false }: { persona: string; compact?: boolean }) {
  const { state } = useVoiceAssistant();
  const isSpeaking = state === "speaking";
  const isThinking = state === "thinking";

  const name = persona.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Trainer";

  return (
    <div
      className={cn(
        "relative size-full overflow-hidden rounded-2xl bg-[linear-gradient(135deg,#a8c6ec_0%,#d2c3e8_50%,#f1c6d7_100%)] shadow-[0_2px_4px_rgba(30,28,25,0.07),0_8px_20px_rgba(30,28,25,0.11)] transition-shadow duration-300",
        isSpeaking && "ring-2 ring-emerald-500/70",
      )}
    >
      {persona.toLowerCase() === "vasanth" ? (
        <Image src="/vasanth.png" alt="" fill sizes={compact ? "220px" : "360px"} className="object-cover" priority />
      ) : (
        <div aria-hidden className="grid size-full place-items-center">
          <span
            className={cn(
              "grid place-items-center rounded-full bg-white/70 font-semibold text-neutral-700",
              compact ? "size-14 text-2xl" : "size-24 text-4xl",
            )}
          >
            {name.charAt(0)}
          </span>
        </div>
      )}

      {isSpeaking || isThinking ? (
        <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", isSpeaking ? "bg-[#e5484d]" : "animate-pulse bg-amber-400")}
          />
          {isSpeaking ? "Speaking" : "Thinking"}
        </span>
      ) : null}

      <span className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
        {name}
      </span>
    </div>
  );
}
