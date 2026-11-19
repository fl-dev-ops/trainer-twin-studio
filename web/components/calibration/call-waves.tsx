"use client";

import { useEffect, useRef, useState } from "react";
import { createAudioAnalyser, type LocalAudioTrack, type RemoteAudioTrack } from "livekit-client";
import { drawCallWaves, MIC_NOISE_GATE } from "@shared/call-waves";
export { MIC_NOISE_GATE, nextLevel } from "@shared/call-waves";

type Voice = { track?: LocalAudioTrack | RemoteAudioTrack; color: string; gate: number };

/**
 * Who is speaking on a call, as two soft glows rising from the bottom edge behind the controls: the twin's (green) and
 * yours (orange), each driven only by its own audio track and layered where both speak. Drawn on a canvas every frame
 * without React renders; a faint ember in silence.
 */
export function CallWaves({ agentTrack, micTrack }: { agentTrack?: RemoteAudioTrack; micTrack?: LocalAudioTrack }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [youSpeaking, setYouSpeaking] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const css = getComputedStyle(canvas);
    const voices: Voice[] = [
      { track: agentTrack, color: css.getPropertyValue("--success").trim() || "#16a34a", gate: 0.02 },
      { track: micTrack, color: css.getPropertyValue("--brand").trim() || "#ff5a00", gate: MIC_NOISE_GATE },
    ];
    const analysers = voices.map((voice) => {
      if (!voice.track) return null;
      // The track itself, not a clone: a clone keeps hearing the mic after LiveKit mutes the original.
      const made = createAudioAnalyser(voice.track);
      // The call started from a click, so the analyser's context may start; if not it reads silence until it can.
      void (made.analyser.context as AudioContext).resume?.().catch(() => {});
      return made;
    });
    const stop = drawCallWaves(canvas, voices.map((voice, index) => ({
      ...voice,
      volume: () => voice.track?.isMuted ? 0 : (analysers[index]?.calculateVolume() ?? 0),
    })), setYouSpeaking);
    return () => {
      stop();
      for (const made of analysers) void made?.cleanup();
    };
  }, [agentTrack, micTrack]);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-8 h-56 w-full blur-xl" />
      <span className="sr-only" aria-live="polite">
        {youSpeaking ? "You're speaking" : ""}
      </span>
    </>
  );
}
