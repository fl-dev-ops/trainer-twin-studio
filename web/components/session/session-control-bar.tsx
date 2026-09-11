"use client";

import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import { LoaderCircle, MessageSquareText, Mic, MicOff, PhoneOff } from "lucide-react";
import { Room, Track } from "livekit-client";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

export function SessionControlBar({
  room,
  isConnected,
  transcriptOpen,
  onTranscriptToggle,
  onEnd,
}: {
  room: Room;
  isConnected: boolean;
  transcriptOpen: boolean;
  onTranscriptToggle: (open: boolean) => void;
  onEnd: () => void;
}) {
  // UNVERIFIED (no LiveKit Docs MCP): checked against current docs and installed v2.9.24 types.
  const { buttonProps: micProps, enabled: micOn, pending: micPending } = useTrackToggle({
    room,
    source: Track.Source.Microphone,
  });
  const { mergedProps: audioProps } = useStartAudio({
    room,
    props: { className: "rounded-full" },
  });

  if (!isConnected) return null;
  return (
    <div className="session-controls flex items-center gap-1 p-1.5" aria-label="Session controls">
      <Button {...audioProps} variant="outline" size="sm">
        Enable audio
      </Button>
      <div className="flex grow items-center gap-1">
        <Button
          {...micProps}
          variant="ghost"
          size="icon"
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          className={cn(
            "rounded-full",
            micProps.className,
            !micOn && "bg-destructive/10 text-destructive hover:bg-destructive/20",
          )}
        >
          {micPending ? <LoaderCircle className="animate-spin" /> : micOn ? <Mic /> : <MicOff />}
        </Button>
        <Toggle
          variant="outline"
          pressed={transcriptOpen}
          aria-label="Toggle transcript"
          onPressedChange={onTranscriptToggle}
          className="rounded-full"
        >
          <MessageSquareText />
        </Toggle>
      </div>
      <Button
        variant="destructive"
        className="rounded-full font-mono text-xs font-bold tracking-wider"
        onClick={onEnd}
      >
        <PhoneOff data-icon="inline-start" />
        <span className="hidden md:inline">END SESSION</span>
        <span className="inline md:hidden">END</span>
      </Button>
    </div>
  );
}
