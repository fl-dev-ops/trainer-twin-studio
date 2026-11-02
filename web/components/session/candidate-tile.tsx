"use client";

import { useLocalParticipant, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import { MicOff, UserRound, VideoOff } from "lucide-react";
import { cn } from "@/lib/utils";

/** Your own tile (V2 prototype): camera feed, or your initial on a dark card. */
export function CandidateTile({ name, compact = false }: { name?: string; compact?: boolean }) {
  const { isMicrophoneEnabled: micOn, isCameraEnabled: cameraOn, cameraTrack, localParticipant } = useLocalParticipant();
  const initial = name?.trim().charAt(0).toUpperCase();

  return (
    <div className="relative size-full overflow-hidden dark rounded-2xl bg-card text-white shadow-elevation-2">
      {cameraOn && cameraTrack ? (
        <VideoTrack
          trackRef={{ participant: localParticipant, publication: cameraTrack, source: Track.Source.Camera }}
          className="absolute inset-0 size-full scale-x-[-1] object-cover"
        />
      ) : (
        <div aria-hidden className="grid size-full place-items-center">
          <span
            className={cn(
              "grid place-items-center rounded-full bg-white/15 font-medium",
              compact ? "size-14 text-2xl" : "size-24 text-4xl",
            )}
          >
            {initial || <UserRound className={compact ? "size-6" : "size-9"} strokeWidth={1.5} />}
          </span>
        </div>
      )}

      <span className="absolute bottom-3 left-3 flex items-center gap-1.5 text-xs font-medium text-shadow-caption">
        You
        {micOn ? null : <MicOff className="size-3.5 text-danger" aria-label="Microphone off" />}
      </span>
      {cameraOn ? null : <VideoOff className="absolute right-3 bottom-3 size-4 text-white/70" aria-label="Camera off" />}
    </div>
  );
}
