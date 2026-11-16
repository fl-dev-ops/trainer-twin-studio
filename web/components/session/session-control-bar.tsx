"use client";

import { useState } from "react";
import { useStartAudio, useTrackToggle } from "@livekit/components-react";
import { LoaderCircle, MessageSquareText, Paperclip, Video, VideoOff, Volume2 } from "lucide-react";
import { Room, Track } from "livekit-client";
import { CallControlButton } from "@/components/conversation/controls";
import { ChatIcon, HangUpIcon, MicIcon } from "@/components/calibration/call-icons";
import { useCallMicrophone } from "@/hooks/use-call-microphone";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/** Same control components and microphone recovery as twin conversations; role-play actions stay with SessionView. */
export function SessionControlBar({ room, isConnected, chatOpen, onChatToggle, composerOpen, onComposerToggle, onEnd, onAttach, attaching = false }: {
  room?: Room;
  isConnected: boolean;
  chatOpen: boolean;
  onChatToggle: () => void;
  composerOpen?: boolean;
  onComposerToggle?: () => void;
  onEnd: () => void;
  onAttach?: () => void;
  attaching?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { buttonProps: cameraProps, enabled: cameraOn, pending: cameraPending } = useTrackToggle({ room, source: Track.Source.Camera });
  const mic = useCallMicrophone(room);
  const { mergedProps: audioProps, canPlayAudio } = useStartAudio({ room, props: {} });
  if (!isConnected) return null;
  return <>
    <div aria-label="Session controls" role="toolbar" className="relative flex max-w-full flex-wrap items-center justify-center gap-1.5 sm:gap-4">
      {!canPlayAudio && <CallControlButton {...audioProps} title="Enable audio" aria-label="Enable audio"><Volume2 /></CallControlButton>}
      <CallControlButton {...cameraProps} disabled={cameraPending} aria-label={cameraOn ? "Turn off camera" : "Turn on camera"} aria-pressed={cameraOn}
        title={cameraOn ? "Turn off camera" : "Turn on camera"} className={cameraOn ? "bg-card" : undefined}>
        {cameraPending ? <LoaderCircle className="animate-spin" /> : cameraOn ? <Video /> : <VideoOff />}
      </CallControlButton>
      <CallControlButton aria-label={mic.enabled ? "Mute microphone" : "Unmute microphone"} aria-pressed={!mic.enabled} disabled={mic.pending}
        onClick={() => void mic.onClick()} className={!mic.enabled ? "bg-foreground text-background hover:bg-foreground/90" : undefined}>
        {mic.pending ? <LoaderCircle className="animate-spin" /> : <MicIcon off={!mic.enabled} />}
      </CallControlButton>
      {onComposerToggle && <CallControlButton onClick={onComposerToggle} aria-label={composerOpen ? "Close message box" : "Type a message"} aria-pressed={Boolean(composerOpen)}
        style={{ "--call-chat-lines": composerOpen ? "var(--card)" : "var(--muted)" } as React.CSSProperties} className={composerOpen ? "bg-card" : undefined}>
        <ChatIcon />
      </CallControlButton>}
      <CallControlButton onClick={onChatToggle} aria-label="Transcript" aria-pressed={chatOpen} title={chatOpen ? "Hide transcript" : "Show transcript"} className={chatOpen ? "bg-card" : undefined}>
        <MessageSquareText />
      </CallControlButton>
      {onAttach && <CallControlButton onClick={onAttach} disabled={attaching} aria-label="Attach a file" title="Attach a file">
        {attaching ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
      </CallControlButton>}
      <CallControlButton onClick={() => setConfirmOpen(true)} aria-label="End session" title="End session" className="border-transparent bg-live text-white hover:bg-live-hover"><HangUpIcon /></CallControlButton>
    </div>
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent className="flex max-w-[420px]! flex-col items-center gap-2 px-6 pt-8 pb-6 text-center">
        <AlertDialogTitle className="text-xl leading-7 font-semibold tracking-title">End this session?</AlertDialogTitle>
        <AlertDialogDescription>Your transcript and feedback will be saved.</AlertDialogDescription>
        <div className="mt-4 grid w-full grid-cols-2 gap-2">
          <button type="button" onClick={() => { setConfirmOpen(false); onEnd(); }} className={cn("h-10 rounded-full bg-card px-4 text-sm font-semibold shadow-elevation-1 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50")}>
            Yes, end session
          </button>
          <AlertDialogCancel variant="default" className="h-10">No, I’ll continue</AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
