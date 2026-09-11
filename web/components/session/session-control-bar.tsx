"use client";

import { useState } from "react";
import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import { LoaderCircle, MessageSquareText, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import { Room, Track } from "livekit-client";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export function SessionControlBar({
  room,
  isConnected,
  transcriptOpen,
  onTranscriptToggle,
  onEnd,
}: {
  room?: Room;
  isConnected: boolean;
  transcriptOpen: boolean;
  onTranscriptToggle: (open: boolean) => void;
  onEnd: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { buttonProps: micProps, enabled: micOn, pending: micPending } = useTrackToggle({
    room,
    source: Track.Source.Microphone,
  });
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({
    room,
    props: { className: "rounded-full" },
  });

  if (!isConnected) return null;
  return (
    <>
      <div className="session-controls flex items-center gap-1.5 p-1.5" aria-label="Session controls">
        {!canPlayAudio && (
          <Button {...audioProps} variant="outline" size="sm" className="rounded-full">
            <Volume2 className="size-4" />
            Enable audio
          </Button>
        )}
        <div className="flex grow items-center gap-1.5">
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
            aria-label="Toggle transcript & chat"
            onPressedChange={onTranscriptToggle}
            className="rounded-full"
          >
            <MessageSquareText />
          </Toggle>
        </div>
        <Button
          variant="destructive"
          className="rounded-full font-mono text-xs font-bold tracking-wider"
          onClick={() => setConfirmOpen(true)}
        >
          <PhoneOff data-icon="inline-start" />
          <span className="hidden md:inline">END SESSION</span>
          <span className="inline md:hidden">END</span>
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End practice session?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to end this session? Your interview transcript and
              feedback will be saved to Sessions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onEnd();
              }}
            >
              End session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
