"use client";

import { useEffect } from "react";
import { useTrackToggle } from "@livekit/components-react";
import { type LocalAudioTrack, ParticipantEvent, type Room, Track } from "livekit-client";
import { toast } from "sonner";

export function micProblem(error: unknown, retry = "click the mic") {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") return `The browser blocked the microphone. Allow it for this site, then ${retry}.`;
  if (name === "NotReadableError" || name === "AbortError") return `The microphone is busy (another app or tab may be using it). Close that, then ${retry}.`;
  if (name === "NotFoundError") return `No microphone was found. Connect one, then ${retry}.`;
  return `The microphone could not start${error instanceof Error && error.message ? `: ${error.message}` : ""}. Then ${retry}.`;
}

/** The twin's microphone behavior, shared with role plays. State always comes from the real LiveKit track. */
export function useCallMicrophone(room?: Room) {
  const { toggle, enabled, pending } = useTrackToggle({ room, source: Track.Source.Microphone, onDeviceError: error => toast.error(micProblem(error)) });
  async function onClick() {
    const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    const raw = track?.mediaStreamTrack;
    try {
      if (track && raw && (raw.readyState === "ended" || raw.muted)) {
        await track.restartTrack();
        await toggle(true);
      } else await toggle();
    } catch (error) {
      console.error("Microphone toggle failed:", error);
      toast.error(micProblem(error));
    }
  }
  useEffect(() => {
    if (!room) return;
    const local = room.localParticipant;
    let raw: MediaStreamTrack | undefined;
    const paused = () => toast.warning("Your browser paused the microphone. Click the mic to turn it back on.");
    const watch = () => {
      raw?.removeEventListener("mute", paused);
      raw = local.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      raw?.addEventListener("mute", paused);
    };
    local.on(ParticipantEvent.LocalTrackPublished, watch).on(ParticipantEvent.TrackUnmuted, watch);
    watch();
    return () => {
      local.off(ParticipantEvent.LocalTrackPublished, watch).off(ParticipantEvent.TrackUnmuted, watch);
      raw?.removeEventListener("mute", paused);
    };
  }, [room]);
  return { enabled, pending, onClick };
}
