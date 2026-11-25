"use client";

import { useIsSpeaking, useLocalParticipant, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import { MicOff, UserRound, VideoOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { NameWave } from "./name-wave";

/** Your own tile (V2 prototype): camera feed, or your initial on a dark card. */
export function CandidateTile({ name, compact = false }: { name?: string; compact?: boolean }) {
  const { isMicrophoneEnabled: micOn, isCameraEnabled: cameraOn, cameraTrack, localParticipant } = useLocalParticipant();
  const isSpeaking = useIsSpeaking(localParticipant);
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

      <span className="absolute right-4 bottom-4 flex max-w-[calc(100%-2rem)] items-center truncate rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
        <NameWave tone={micOn && isSpeaking ? "speaking" : "listening"} />
        <span className="flex items-center gap-2">
          You
          {micOn ? null : <MicOff className="size-3.5 text-danger" aria-label="Microphone off" />}
        </span>
      </span>
      {cameraOn ? null : <VideoOff className="absolute bottom-4 left-4 size-4 text-white/70" aria-label="Camera off" />}
    </div>
  );
}
