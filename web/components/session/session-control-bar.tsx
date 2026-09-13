"use client";

import { useState } from "react";
import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import {
  Captions,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { Room, Track } from "livekit-client";
import { Button } from "@/components/ui/button";
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
  subtitlesActive,
  onSubtitlesToggle,
  chatOpen,
  onChatToggle,
  onEnd,
}: {
  room?: Room;
  isConnected: boolean;
  subtitlesActive: boolean;
  onSubtitlesToggle: () => void;
  chatOpen: boolean;
  onChatToggle: () => void;
  onEnd: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

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
      <div
        className="flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-[#1b1e24] p-1.5 px-3.5 shadow-[0_16px_36px_-4px_rgba(0,0,0,0.6)] backdrop-blur-xl"
        aria-label="Session controls"
      >
        {!canPlayAudio && (
          <Button {...audioProps} variant="outline" size="sm" className="rounded-full">
            <Volume2 className="size-4" />
            Enable audio
          </Button>
        )}

        {/* 1. Camera / Video */}
        <button
          type="button"
          onClick={() => setCameraActive((v) => !v)}
          title="Toggle camera (Voice only)"
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground",
            cameraActive && "bg-white/15 text-white",
          )}
        >
          {cameraActive ? <Video className="size-5" /> : <VideoOff className="size-5" />}
        </button>

        {/* 2. Microphone */}
        <button
          {...micProps}
          type="button"
          title={micOn ? "Mute microphone" : "Unmute microphone"}
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground",
            !micOn && "bg-red-500/20 text-red-400 hover:bg-red-500/30",
          )}
        >
          {micPending ? (
            <LoaderCircle className="size-5 animate-spin" />
          ) : micOn ? (
            <Mic className="size-5" />
          ) : (
            <MicOff className="size-5" />
          )}
        </button>

        {/* 3. Live Subtitles (CC) */}
        <button
          type="button"
          onClick={onSubtitlesToggle}
          title="Toggle live subtitles"
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground",
            subtitlesActive && "bg-white/15 text-white",
          )}
        >
          <Captions className="size-5" />
        </button>

        {/* 4. Chat Toggle */}
        <button
          type="button"
          onClick={onChatToggle}
          title="Toggle chat panel"
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground",
            chatOpen && "bg-white/15 text-white",
          )}
        >
          <MessageSquare className="size-5" />
        </button>

        {/* 5. Red Circular End Call Button */}
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          title="End session"
          className="ml-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-[#e03b3b] text-white shadow-md transition-transform duration-100 hover:scale-105 hover:bg-[#c52b2b]"
        >
          <PhoneOff className="size-5" />
        </button>
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
