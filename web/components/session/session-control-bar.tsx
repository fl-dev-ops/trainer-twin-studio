"use client";

import { useState } from "react";
import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import {
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
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

const controlClass = "grid size-10 shrink-0 place-items-center rounded-full transition-colors";
const idleClass = "text-neutral-700 hover:bg-neutral-200/70";
const offClass = "bg-[#e03b3b] text-white hover:bg-[#c52b2b]";

export function SessionControlBar({
  room,
  isConnected,
  chatOpen,
  onChatToggle,
  screenSharing,
  screenSharePending,
  onScreenShare,
}: {
  room?: Room;
  isConnected: boolean;
  chatOpen: boolean;
  onChatToggle: () => void;
  screenSharing: boolean;
  screenSharePending: boolean;
  /** Starts the whole-screen share; stopping is not offered because the session requires it. */
  onScreenShare: () => void;
}) {
  const { buttonProps: cameraProps, enabled: cameraOn, pending: cameraPending } = useTrackToggle({
    room,
    source: Track.Source.Camera,
  });

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
    <div
      className="flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-100/90 p-1.5 shadow-sm backdrop-blur-xl"
      aria-label="Session controls"
    >
      {!canPlayAudio && (
        <Button {...audioProps} variant="outline" size="sm" className="rounded-full">
          <Volume2 className="size-4" />
          Enable audio
        </Button>
      )}

      <button
        {...cameraProps}
        type="button"
        title={cameraOn ? "Turn off camera" : "Turn on camera"}
        className={cn(controlClass, cameraOn ? idleClass : offClass)}
      >
        {cameraPending ? <LoaderCircle className="size-5 animate-spin" /> : cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
      </button>

      <button
        {...micProps}
        type="button"
        title={micOn ? "Mute microphone" : "Unmute microphone"}
        className={cn(controlClass, micOn ? idleClass : offClass)}
      >
        {micPending ? <LoaderCircle className="size-5 animate-spin" /> : micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
      </button>

      <button
        type="button"
        onClick={screenSharing ? undefined : onScreenShare}
        disabled={screenSharePending}
        aria-pressed={screenSharing}
        title={screenSharing ? "Sharing your entire screen" : "Share entire screen"}
        className={cn(controlClass, idleClass, screenSharing && "bg-neutral-200 text-emerald-600")}
      >
        {screenSharePending ? <LoaderCircle className="size-5 animate-spin" /> : <ScreenShare className="size-5" />}
      </button>

      <button
        type="button"
        onClick={onChatToggle}
        aria-pressed={chatOpen}
        title="Toggle chat panel"
        className={cn(controlClass, idleClass, chatOpen && "bg-neutral-200")}
      >
        <MessageSquare className="size-5" />
      </button>
    </div>
  );
}

export function EndSessionButton({ onEnd }: { onEnd: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        aria-label="End session"
        className="flex h-10 items-center gap-2 rounded-full bg-[#e03b3b] px-3.5 text-sm sm:px-6 font-semibold text-white shadow-md transition-colors hover:bg-[#c52b2b]"
      >
        <PhoneOff className="size-4" />
        <span className="hidden sm:inline">End</span>
      </button>

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
