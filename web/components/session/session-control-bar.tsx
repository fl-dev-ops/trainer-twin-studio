"use client";

import { useState } from "react";
import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import { LoaderCircle, MessageSquareText, Mic, MicOff, PhoneOff, Video, VideoOff, Volume2 } from "lucide-react";
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
  "grid size-10 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-[18px]";

/**
 * Call controls (V2 prototype): the toggle pill and the End button.
 * Renders two grid cells, so the parent footer must be a 3-column grid (timer | controls | end).
 */
export function SessionControlBar({
  room,
  isConnected,
  chatOpen,
  onChatToggle,
  onEnd,
}: {
  room?: Room;
  isConnected: boolean;
  chatOpen: boolean;
  onChatToggle: () => void;
  onEnd: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { buttonProps: cameraProps, enabled: cameraOn, pending: cameraPending } = useTrackToggle({ room, source: Track.Source.Camera });
  const { buttonProps: micProps, enabled: micOn, pending: micPending } = useTrackToggle({ room, source: Track.Source.Microphone });
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({ room, props: {} });

  if (!isConnected) return null;

  return (
    <>
      <div aria-label="Session controls" role="toolbar" className="col-start-2 flex items-center gap-2 rounded-full bg-muted p-1.5">
        {!canPlayAudio && (
          <button {...audioProps} type="button" className={cn(CONTROL, "w-auto gap-2 bg-card px-4 text-sm font-medium")}>
            <Volume2 />
            Enable audio
          </button>
        )}
        <button
          {...cameraProps}
          type="button"
          aria-label={cameraOn ? "Turn off camera" : "Turn on camera"}
          title={cameraOn ? "Turn off camera" : "Turn on camera"}
          className={cn(CONTROL, cameraOn ? "hover:bg-card" : "bg-[#ce2c33] text-white hover:bg-[#b5262c]")}
        >
          {cameraPending ? <LoaderCircle className="animate-spin" /> : cameraOn ? <Video /> : <VideoOff />}
        </button>
        <button
          {...micProps}
          type="button"
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          title={micOn ? "Mute microphone" : "Unmute microphone"}
          className={cn(CONTROL, micOn ? "hover:bg-card" : "bg-[#ce2c33] text-white hover:bg-[#b5262c]")}
        >
          {micPending ? <LoaderCircle className="animate-spin" /> : micOn ? <Mic /> : <MicOff />}
        </button>
        <button
          type="button"
          onClick={onChatToggle}
          aria-label="Chat"
          aria-pressed={chatOpen}
          title={chatOpen ? "Hide chat" : "Show chat"}
          className={cn(CONTROL, chatOpen ? "bg-card shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "hover:bg-card")}
        >
          <MessageSquareText />
        </button>
      </div>

      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        aria-label="End session"
        className="col-start-3 inline-flex h-10 items-center gap-2 justify-self-end rounded-full bg-[#ce2c33] px-5 text-[15px] font-medium text-white outline-none transition-colors hover:bg-[#b5262c] focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <PhoneOff className="size-[18px]" />
        End
      </button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-2 rounded-3xl px-6 pt-8 pb-6 text-center">
          <AlertDialogTitle className="text-xl leading-7 font-semibold tracking-[-0.015em]">End this session?</AlertDialogTitle>
          <AlertDialogDescription>Your transcript and feedback will be saved.</AlertDialogDescription>
          <div className="mt-4 grid w-full grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                onEnd();
              }}
              className="h-10 rounded-full bg-card px-4 text-sm font-semibold shadow-[0_0_1px_rgba(0,0,0,0.4),0_1px_1px_rgba(0,0,0,0.04),0_2px_4px_rgba(0,0,0,0.04)] outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 dark:shadow-[0_0_0_1px_var(--border)]"
            >
              Yes, end session
            </button>
            <AlertDialogCancel variant="default" className="h-10 rounded-full px-4 text-sm font-semibold">
              No, I’ll continue
            </AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
