"use client";

import { useLocalParticipant, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export function CandidateTile({ compact = false }: { compact?: boolean }) {
  const {
    isMicrophoneEnabled: micOn,
    isCameraEnabled: cameraOn,
    cameraTrack,
    localParticipant,
  } = useLocalParticipant();

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-white/[0.035] bg-[#1c1f26]">
      {/* Radial atmosphere */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,#222630_0%,#15171d_100%)]" />

      {/* Video Feed when Camera is Enabled */}
      {cameraOn && cameraTrack ? (
        <VideoTrack
          trackRef={{
            participant: localParticipant,
            publication: cameraTrack,
            source: Track.Source.Camera,
          }}
          className="absolute inset-0 h-full w-full object-cover scale-x-[-1]"
        />
      ) : (
        /* Center Audio Circle with Pulsing Glow when Camera is Off */
        <div className="relative flex items-center justify-center">
          {micOn && (
            <>
              <div className="pointer-events-none absolute size-24 rounded-full bg-indigo-500/20 [animation:agent-halo-pulse_2.2s_infinite_cubic-bezier(0.2,0.6,0.35,1)]" />
              <div className="pointer-events-none absolute size-36 rounded-full bg-indigo-500/10 [animation:agent-halo-pulse_2.2s_infinite_cubic-bezier(0.2,0.6,0.35,1)] [animation-delay:0.5s]" />
            </>
          )}

          <motion.div
            layout
            animate={{
              width: compact ? 48 : 64,
              height: compact ? 48 : 64,
            }}
            transition={{ type: "spring", stiffness: 300, damping: 32, mass: 0.8 }}
            className={cn(
              "relative z-10 grid place-items-center rounded-full border border-white/20 text-white shadow-lg transition-colors duration-200",
              micOn ? "bg-[#323742] shadow-[0_8px_24px_rgba(0,0,0,0.45)]" : "bg-[#252830] text-muted-foreground",
            )}
          >
            {micOn ? (
              <Mic className={compact ? "size-5" : "size-6"} strokeWidth={2} />
            ) : (
              <MicOff className={compact ? "size-5" : "size-6"} strokeWidth={2} />
            )}
          </motion.div>
        </div>
      )}

      {/* Name Pill (Bottom Left) */}
      <div className="absolute bottom-3.5 left-3.5 z-20 flex items-center gap-1.5 rounded-md border border-white/[0.04] bg-[#121419]/85 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur-md">
        <span>You</span>
        <span className={cn("size-1.5 rounded-full", micOn ? "bg-emerald-500" : "bg-red-500")} />
      </div>

      {/* Camera Indicator (Bottom Right) */}
      <div className="absolute bottom-3.5 right-3.5 z-20 grid size-6.5 place-items-center rounded-md border border-white/[0.04] bg-[#121419]/65 text-muted-foreground backdrop-blur-md">
        {cameraOn ? (
          <Video className="size-3.5 text-emerald-400" strokeWidth={1.75} />
        ) : (
          <VideoOff className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
        )}
      </div>
    </div>
  );
}
