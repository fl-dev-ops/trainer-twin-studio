"use client";

import { useEffect, useRef, useState } from "react";
import { Square, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Plays a voice's reference recording. */
export function VoicePlayButton({ voiceId, name, className }: { voiceId: string; name: string; className?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => () => audio.current?.pause(), []);

  async function toggle(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    try {
      const response = await fetch(`/api/tts/voices/${encodeURIComponent(voiceId)}`);
      const data = (await response.json()) as { audioUrl?: string };
      if (!response.ok || !data.audioUrl) return;
      audio.current?.pause();
      audio.current = new Audio(data.audioUrl);
      audio.current.onended = () => setPlaying(false);
      await audio.current.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? `Stop ${name}` : `Play ${name}`}
      className={cn("inline-grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground", className)}
    >
      {playing ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-4" />}
    </button>
  );
}
