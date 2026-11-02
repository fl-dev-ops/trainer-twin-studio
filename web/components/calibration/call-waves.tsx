"use client";

import { useEffect, useRef, useState } from "react";
import { createAudioAnalyser, type LocalAudioTrack, type RemoteAudioTrack } from "livekit-client";

type Voice = { track?: LocalAudioTrack | RemoteAudioTrack; color: string; gate: number };

/** Mic levels below this are room noise, not speech (createAudioAnalyser volume, 0-1). Tune by ear. */
export const MIC_NOISE_GATE = 0.06;
const ATTACK = 0.3;
const RELEASE = 0.06;

/** A gated, smoothed level: noise under `gate` reads as 0, the rest is rescaled to 0-1 and eased (fast up, slow down). */
export function nextLevel(previous: number, volume: number, gate: number) {
  const target = Math.min(1, Math.max(0, (volume - gate) / (1 - gate)) * 2.5);
  return previous + (target - previous) * (target > previous ? ATTACK : RELEASE);
}

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
    const levels = voices.map(() => 0);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let you = false;
    let frame = 0;

    const draw = (time: number) => {
      const dpr = devicePixelRatio || 1;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
      ctx.clearRect(0, 0, width, height);
      const t = still ? 0 : time / 1000;
      // The canvas runs past the window's bottom edge (so the blur doesn't fade it there): the glow sits on `floor`.
      const floor = height;

      voices.forEach((voice, v) => {
        // A muted track is silent to the other side, so it is silent here too.
        const volume = voice.track?.isMuted ? 0 : (analysers[v]?.calculateVolume() ?? 0);
        levels[v] = nextLevel(levels[v], volume, voice.gate);
        const level = levels[v];
        // A soft mound from the floor: an ember in silence, swelling with the voice; its crest drifts slowly.
        const rise = (10 + level * 120) * dpr;
        const centre = 0.5 + (v ? 0.06 : -0.06) * Math.sin(t * 0.3 + v);
        ctx.beginPath();
        ctx.moveTo(0, floor);
        for (let x = 0; x <= width; x += 6 * dpr) {
          const p = x / width;
          const mound = 0.3 + 0.7 * Math.exp(-(((p - centre) / 0.3) ** 2));
          const swell = 1 + 0.2 * Math.sin(p * Math.PI * 2.6 + t * 0.9 + v * 2) + 0.1 * Math.sin(p * Math.PI * 5.4 - t * 1.3);
          ctx.lineTo(x, floor - rise * mound * swell);
        }
        ctx.lineTo(width, floor);
        ctx.closePath();
        const glow = ctx.createLinearGradient(0, floor - rise * 1.3, 0, floor);
        glow.addColorStop(0, "transparent");
        glow.addColorStop(0.55, voice.color);
        glow.addColorStop(1, voice.color);
        ctx.fillStyle = glow;
        ctx.globalAlpha = 0.14 + level * 0.5;
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      // Announce only changes, with a little hysteresis so it doesn't flap.
      const speakingNow = levels[1] > (you ? 0.05 : 0.15);
      if (speakingNow !== you) setYouSpeaking((you = speakingNow));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
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
