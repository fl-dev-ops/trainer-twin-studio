"use client";

import { useLocalParticipant, useVoiceAssistant } from "@livekit/components-react";
import type { LocalAudioTrack, RemoteAudioTrack } from "livekit-client";
import { CallWaves } from "@/components/calibration/call-waves";

export function ConversationWaves({ active }: { active: boolean }) {
  const { audioTrack } = useVoiceAssistant();
  const { microphoneTrack } = useLocalParticipant();
  return active ? <CallWaves agentTrack={audioTrack?.publication.track as RemoteAudioTrack | undefined} micTrack={microphoneTrack?.track as LocalAudioTrack | undefined} /> : null;
}
