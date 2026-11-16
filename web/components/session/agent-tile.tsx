"use client";

import { useVoiceAssistant } from "@livekit/components-react";
import { ConversationPortrait } from "@/components/conversation/parts";
import { cn } from "@/lib/utils";

/** Same portrait as twin conversations, with the role-play's existing live speaking state. */
export function AgentTile({ persona, photoUrl = null, compact = false }: { persona: string; photoUrl?: string | null; compact?: boolean }) {
  const { state } = useVoiceAssistant();
  const speaking = state === "speaking";
  const name = persona.replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase()) || "Trainer";
  return <div className={cn("relative size-full overflow-hidden rounded-stage bg-muted shadow-elevation-2 transition-shadow", speaking && "ring-2 ring-success-border")}>
    <ConversationPortrait name={name} photoUrl={photoUrl ?? (persona.toLowerCase() === "vasanth" ? "/vasanth.png" : null)} className="size-full text-7xl" />
    {(speaking || state === "thinking") && <span className={cn("absolute top-3 left-3 rounded-full bg-black/45 px-2.5 py-1 text-xs font-medium text-white", compact && "max-md:hidden")}>
      {speaking ? "Speaking" : "Thinking"}
    </span>}
  </div>;
}
