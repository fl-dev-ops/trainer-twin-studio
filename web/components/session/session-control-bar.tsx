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
import { Button } from "@/components/ui/button";

/**
 * Call controls (V2 prototype): the toggle pill and the End button.
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
      <div aria-label="Session controls" role="toolbar" className="flex w-fit min-w-0 flex-wrap items-center gap-1 rounded-full bg-muted p-1">
        {!canPlayAudio && (
          <Button {...audioProps} type="button" variant="secondary" title="Enable audio">
            <Volume2 />
            Enable audio
          </Button>
        )}
        <Button
          {...cameraProps}
          type="button"
          variant={cameraOn ? "ghost" : "secondary"}
          iconOnly
          aria-label={cameraOn ? "Turn off camera" : "Turn on camera"}
          title={cameraOn ? "Turn off camera" : "Turn on camera"}
        >
          {cameraPending ? <LoaderCircle className="animate-spin" /> : cameraOn ? <Video /> : <VideoOff />}
        </Button>
        <Button
          {...micProps}
          type="button"
          variant={micOn ? "ghost" : "secondary"}
          iconOnly
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          title={micOn ? "Mute microphone" : "Unmute microphone"}
        >
          {micPending ? <LoaderCircle className="animate-spin" /> : micOn ? <Mic /> : <MicOff />}
        </Button>
        <Button
          type="button"
          onClick={onChatToggle}
          variant={chatOpen ? "secondary" : "ghost"}
          iconOnly
          aria-label="Chat"
          aria-pressed={chatOpen}
          title={chatOpen ? "Hide chat" : "Show chat"}
        >
          <MessageSquareText />
        </Button>
        {onAttach ? (
          <Button
            type="button"
            onClick={onAttach}
            disabled={attaching}
            variant="ghost"
            iconOnly
            aria-label="Attach a file"
            title="Attach a file"
          >
            {attaching ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
          </Button>
        ) : null}
      </div>

      <Button
        type="button"
        onClick={() => setConfirmOpen(true)}
        aria-label="End session"
        className="ml-auto"
      >
        <PhoneOff />
        End
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-2 px-6 pt-8 pb-6 text-center">
          <AlertDialogTitle className="text-xl leading-7 font-semibold tracking-title">End this session?</AlertDialogTitle>
          <AlertDialogDescription>Your transcript and feedback will be saved.</AlertDialogDescription>
          <div className="mt-4 grid w-full grid-cols-2 gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirmOpen(false);
                onEnd();
              }}
            >
              Yes, end session
            </Button>
            <AlertDialogCancel variant="default">
              No, I’ll continue
            </AlertDialogCancel>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
