"use client";

import Image from "next/image";
import { UserRound } from "lucide-react";
import { useVoiceAssistant } from "@livekit/components-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export function AgentTile({ persona, compact = false }: { persona: string; compact?: boolean }) {
  const voiceAssistant = useVoiceAssistant();
  const rawState = voiceAssistant.state;
  const isSpeaking = rawState === "speaking";
  const isThinking = rawState === "thinking";
  const isListening = rawState === "listening" || !rawState;

  const name = persona.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-[#1c1f26] transition-all duration-300",
        isSpeaking && "border border-emerald-500/40 shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_12px_32px_rgba(0,0,0,0.4)]",
        isThinking && "border border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.2)]",
        !isSpeaking && !isThinking && "border border-white/[0.035]",
      )}
    >
      {/* Background radial atmosphere */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,#242833_0%,#15171d_100%)]" />

      {/* AI Voice Reactive Orb */}
      <div className="relative flex items-center justify-center">
        {/* Speaking State: Fluid Green Halo Pulse */}
        {isSpeaking && (
          <>
            <div className="pointer-events-none absolute size-32 rounded-full bg-emerald-500/20 [animation:agent-halo-pulse_2.2s_infinite_cubic-bezier(0.2,0.6,0.35,1)]" />
            <div className="pointer-events-none absolute size-44 rounded-full bg-emerald-500/15 [animation:agent-halo-pulse_2.2s_infinite_cubic-bezier(0.2,0.6,0.35,1)] [animation-delay:0.5s]" />
          </>
        )}

        {/* Thinking State: Hypnotic Amber Breathing Aura */}
        {isThinking && (
          <>
            <div className="pointer-events-none absolute size-32 rounded-full bg-amber-500/25 [animation:agent-breathe-amber_1.8s_infinite_ease-in-out]" />
            <div className="pointer-events-none absolute size-44 rounded-full bg-amber-500/15 [animation:agent-breathe-amber_1.8s_infinite_ease-in-out] [animation-delay:0.4s]" />
          </>
        )}

        {/* Listening State: Calm Soft Cyan Glow */}
        {isListening && (
          <div className="pointer-events-none absolute size-36 scale-105 rounded-full bg-sky-400/[0.08] opacity-70 transition-opacity duration-300" />
        )}

        {/* Avatar Orb Frame */}
        <motion.div
          layout
          animate={{
            width: compact ? 72 : 110,
            height: compact ? 72 : 110,
          }}
          transition={{ type: "spring", stiffness: 300, damping: 32, mass: 0.8 }}
          className="relative z-10 shrink-0 overflow-hidden rounded-full border-2 border-white/20 bg-[#222630] shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        >
          {persona.toLowerCase() === "vasanth" ? (
            <Image
              src="/vasanth.png"
              alt={name || "Trainer"}
              fill
              sizes={compact ? "72px" : "110px"}
              className="object-cover"
              priority
            />
          ) : (
            <div className="grid size-full place-items-center text-muted-foreground">
              <UserRound className={compact ? "size-6" : "size-10"} strokeWidth={1.5} />
            </div>
          )}
        </motion.div>
      </div>

      {/* Name Pill (Bottom Left, Riverside style) */}
      <div className="absolute bottom-3.5 left-3.5 z-20 flex items-center gap-1.5 rounded-md border border-white/[0.04] bg-[#121419]/85 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur-md">
        <span>{name || "Trainer"}</span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            isSpeaking && "bg-emerald-500",
            isThinking && "animate-pulse bg-amber-500",
            isListening && "bg-sky-400",
          )}
        />
      </div>
    </div>
  );
}
