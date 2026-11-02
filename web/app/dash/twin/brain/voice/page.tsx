"use client";

import { TwinVoiceCapture } from "@/components/twin/twin-voice-capture";
import { api, useApi } from "@/lib/api";

/** The twin's voice, recorded on camera: the take's audio clones the voice, its video is the AI avatar reference. */
export default function TwinVoiceRoute() {
  const state = useApi(["twin.avatar.get"], () => api.twin.avatar.get.query());
  return <TwinVoiceCapture personaName={state?.personaName ?? null} />;
}
