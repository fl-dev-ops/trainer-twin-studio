"use client";

import { useState } from "react";
import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import { LoaderCircle, MessageSquareText, Mic, MicOff, Paperclip, PhoneOff, Video, VideoOff, Volume2 } from "lucide-react";
import { Room, Track } from "livekit-client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

const CONTROL =
  "grid size-11 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 md:size-10 [&_svg]:size-[18px]";

/**
 * Call controls (V2 prototype): the toggle pill and the End button.
 * Renders two grid cells: controls + end on mobile, timer | controls | end on desktop.
 */
export function SessionControlBar({
  room,
  isConnected,
  chatOpen,
  onChatToggle,
  onEnd,
  onAttach,
  attaching = false,
}: {
  room?: Room;
  isConnected: boolean;
  chatOpen: boolean;
  onChatToggle: () => void;
  onEnd: () => void;
  /** Shown only when the agent lets the learner attach a file during the conversation. */
  onAttach?: () => void;
  attaching?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { buttonProps: cameraProps, enabled: cameraOn, pending: cameraPending } = useTrackToggle({ room, source: Track.Source.Camera });
  const { buttonProps: micProps, enabled: micOn, pending: micPending } = useTrackToggle({ room, source: Track.Source.Microphone });
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({ room, props: {} });

  if (!isConnected) return null;

  return (
    <>
      <div aria-label="Session controls" role="toolbar" className="col-start-1 flex w-fit items-center gap-1 rounded-full bg-muted p-1 md:col-start-2 md:gap-2 md:p-1.5">
        {!canPlayAudio && (
          <button {...audioProps} type="button" title="Enable audio" className={cn(CONTROL, "bg-card text-sm font-medium md:flex md:w-auto md:gap-2 md:px-4")}>
            <Volume2 />
            <span className="sr-only md:not-sr-only">Enable audio</span>
          </button>
        )}
        <button
          {...cameraProps}
          type="button"
          aria-label={cameraOn ? "Turn off camera" : "Turn on camera"}
          title={cameraOn ? "Turn off camera" : "Turn on camera"}
          className={cn(CONTROL, cameraOn ? "hover:bg-card" : "bg-live text-white hover:bg-live-hover")}
        >
          {cameraPending ? <LoaderCircle className="animate-spin" /> : cameraOn ? <Video /> : <VideoOff />}
        </button>
        <button
          {...micProps}
          type="button"
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          title={micOn ? "Mute microphone" : "Unmute microphone"}
          className={cn(CONTROL, micOn ? "hover:bg-card" : "bg-live text-white hover:bg-live-hover")}
        >
          {micPending ? <LoaderCircle className="animate-spin" /> : micOn ? <Mic /> : <MicOff />}
        </button>
        <button
          type="button"
          onClick={onChatToggle}
          aria-label="Chat"
          aria-pressed={chatOpen}
          title={chatOpen ? "Hide chat" : "Show chat"}
          className={cn(CONTROL, chatOpen ? "bg-card shadow-elevation-1" : "hover:bg-card")}
        >
          <MessageSquareText />
        </button>
        {onAttach ? (
          <button
            type="button"
            onClick={onAttach}
            disabled={attaching}
            aria-label="Attach a file"
            title="Attach a file"
            className={cn(CONTROL, "hover:bg-card disabled:opacity-60")}
          >
            {attaching ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
          </button>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        aria-label="End session"
        className="col-start-2 inline-flex size-11 items-center justify-center gap-2 justify-self-end rounded-full bg-live text-body font-medium text-white outline-none transition-colors hover:bg-live-hover focus-visible:ring-3 focus-visible:ring-ring/50 md:col-start-3 md:h-10 md:w-auto md:px-5"
      >
        <PhoneOff className="size-[18px]" />
        <span className="sr-only md:not-sr-only">End</span>
      </button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-2 px-6 pt-8 pb-6 text-center">
          <AlertDialogTitle className="text-xl leading-7 font-semibold tracking-title">End this session?</AlertDialogTitle>
          <AlertDialogDescription>Your transcript and feedback will be saved.</AlertDialogDescription>
          <div className="mt-4 grid w-full grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                onEnd();
              }}
              className="h-10 rounded-full bg-card px-4 text-sm font-semibold shadow-elevation-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 dark:ring-1 dark:ring-border"
            >
              Yes, end session
            </button>
            <AlertDialogCancel variant="default" className="h-10">
              No, I’ll continue
            </AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
