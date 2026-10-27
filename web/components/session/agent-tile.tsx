"use client";

import Image from "next/image";
import { useVoiceAssistant } from "@livekit/components-react";
import { cn } from "@/lib/utils";

export function AgentTile({ persona, avatar }: { persona: string; avatar?: string }) {
  const { state } = useVoiceAssistant();
  const isSpeaking = state === "speaking";
  const isThinking = state === "thinking";

  const name = persona.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Trainer";
  const photo = avatar ?? (persona.toLowerCase() === "vasanth" ? "/vasanth.png" : undefined);

  return (
    <div
      className={cn(
        "relative size-full overflow-hidden rounded-2xl bg-[#1f1f1f] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)] transition-shadow duration-300",
        isSpeaking && "ring-2 ring-emerald-400/70",
      )}
    >
      {photo ? (
        <Image src={photo} alt={name} fill sizes="320px" className="object-cover" priority />
      ) : (
        <div className="grid size-full place-items-center">
          <span className="grid size-24 place-items-center rounded-full bg-white/10 text-4xl font-medium text-white">
            {name.charAt(0)}
          </span>
        </div>
      )}

      {(isSpeaking || isThinking) && (
        <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
          <span className={cn("size-2 rounded-full", isSpeaking ? "bg-red-500" : "animate-pulse bg-amber-400")} />
          {isSpeaking ? "Speaking" : "Thinking"}
        </div>
      )}

      <div className="absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
        {name}
      </div>
    </div>
  );
}
