"use client";

import { useLocalParticipant, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import { MicOff, VideoOff } from "lucide-react";

export function CandidateTile({ name }: { name: string }) {
  const {
    isMicrophoneEnabled: micOn,
    isCameraEnabled: cameraOn,
    cameraTrack,
    localParticipant,
  } = useLocalParticipant();

  return (
    <div className="relative size-full overflow-hidden rounded-2xl bg-[#1f1f1f] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)]">
      {cameraOn && cameraTrack ? (
        <VideoTrack
          trackRef={{
            participant: localParticipant,
            publication: cameraTrack,
            source: Track.Source.Camera,
          }}
          className="absolute inset-0 size-full scale-x-[-1] object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center">
          <span className="grid size-24 place-items-center rounded-full bg-white/10 text-4xl font-medium text-white">
            {name.charAt(0).toUpperCase()}
          </span>
        </div>
      )}

      <div className="absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md">
        {name}
      </div>

      <div className="absolute right-3 bottom-3 flex items-center gap-2 text-white/80">
        {!micOn && <MicOff className="size-4" strokeWidth={1.75} aria-label="Microphone off" />}
        {!cameraOn && <VideoOff className="size-4" strokeWidth={1.75} aria-label="Camera off" />}
      </div>
    </div>
  );
}
