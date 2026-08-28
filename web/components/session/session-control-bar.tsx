"use client";

import { MessageSquareText, Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

export function SessionControlBar({
  audioBlocked,
  isConnected,
  micOn,
  transcriptOpen,
  onEnableAudio,
  onMicToggle,
  onTranscriptToggle,
  onEnd,
}: {
  audioBlocked: boolean;
  isConnected: boolean;
  micOn: boolean;
  transcriptOpen: boolean;
  onEnableAudio: () => void;
  onMicToggle: () => void;
  onTranscriptToggle: (open: boolean) => void;
  onEnd: () => void;
}) {
  if (!isConnected) return null;
  return (
    <div className="session-controls flex items-center gap-1 p-1.5" aria-label="Session controls">
      {audioBlocked && (
        <Button variant="outline" size="sm" className="rounded-full" onClick={onEnableAudio}>
          Enable audio
        </Button>
      )}
      <div className="flex grow items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          onClick={onMicToggle}
          className={cn("rounded-full", !micOn && "bg-destructive/10 text-destructive hover:bg-destructive/20")}
        >
          {micOn ? <Mic /> : <MicOff />}
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
