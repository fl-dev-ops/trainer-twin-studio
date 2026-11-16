"use client";

import { useVoiceAssistant } from "@livekit/components-react";
import { X } from "lucide-react";
import { AttachedTurn, ConversationBubble, ConversationScroll, type AttachedFiles } from "@/components/conversation/parts";
import { CallComposer } from "@/components/conversation/controls";
import type { Entry } from "@/lib/session-transcript";
import { cn } from "@/lib/utils";

/** The twin's conversation presentation, fed by the existing role-play transcript and send handler. */
export function SessionSidebar({ entries, trainerName = "Trainer", onSendMessage, onClose, disabled = false, className, liveText = "", files }: {
  entries: Entry[];
  trainerName?: string;
  onSendMessage?: (text: string) => void | Promise<void>;
  onClose?: () => void;
  disabled?: boolean;
  className?: string;
  liveText?: string;
  files?: AttachedFiles;
}) {
  const { state } = useVoiceAssistant();
  const last = entries.at(-1);
  const streaming = state === "speaking" && liveText && !(last?.role === "trainer" && last.text === liveText);
  return <section aria-label="Session transcript" className={cn("flex h-full min-h-0 w-full flex-col", className)}>
    <header className="flex shrink-0 items-center justify-between gap-3 px-1 py-2">
      <h2 className="text-xs font-medium text-muted-foreground">Transcript</h2>
      {onClose && <button type="button" onClick={onClose} aria-label="Close transcript" className="grid size-10 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"><X className="size-4" /></button>}
    </header>
    <ConversationScroll className="px-1">
      <div aria-live="polite" className="flex flex-col gap-4 py-4">
        {!entries.length && !streaming && <p className="py-5 text-center text-sm text-muted-foreground">What you and {trainerName} say appears here.</p>}
        {entries.map((entry, index) => entry.role === "user" && entry.text.includes("[ATTACHED")
          ? <AttachedTurn key={index} text={entry.text} files={files} />
          : <div key={index} className={cn("flex flex-col gap-1.5", entry.role === "user" && "items-end")}>
              <span className="sr-only">{entry.role === "user" ? "You" : trainerName}</span>
              <ConversationBubble from={entry.role === "user" ? "you" : "agent"}>{entry.text}</ConversationBubble>
            </div>)}
        {streaming && <ConversationBubble from="agent">{liveText}</ConversationBubble>}
        {state === "thinking" && <p role="status" className="text-sm text-muted-foreground"><span className="shimmer">Thinking…</span></p>}
      </div>
    </ConversationScroll>
    {onSendMessage && <div className="flex shrink-0 justify-center pt-3"><CallComposer name={trainerName} onSend={onSendMessage} disabled={disabled} /></div>}
  </section>;
}
