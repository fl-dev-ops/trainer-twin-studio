"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceAssistant } from "@livekit/components-react";
import { ArrowUp, X } from "lucide-react";
import type { Entry } from "@/lib/session-transcript";
import { cn } from "@/lib/utils";

/** Live chat (V2 prototype): the conversation so far and a message box to the trainer. */
export function SessionSidebar({
  entries,
  trainerName = "Trainer",
  onSendMessage,
  onClose,
  disabled = false,
  className,
}: {
  entries: Entry[];
  trainerName?: string;
  onSendMessage?: (text: string) => void;
  onClose?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const { state } = useVoiceAssistant();
  const isSpeaking = state === "speaking";
  const isThinking = state === "thinking";
  const [inputText, setInputText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, isSpeaking, isThinking]);

  function handleSend() {
    const trimmed = inputText.trim();
    if (disabled || !trimmed) return;
    onSendMessage?.(trimmed);
    setInputText("");
  }

  return (
    <aside
      aria-label="Session chat"
      className={cn(
        // A real border: the slide-in wrapper clips anything drawn outside the box.
        "flex h-full min-h-0 w-[360px] flex-col overflow-hidden rounded-2xl border bg-card",
        className,
      )}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-base font-semibold tracking-[-0.015em]">Chat</h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="grid size-8 place-items-center rounded-full text-foreground/80 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-[18px]" />
          </button>
        ) : null}
      </header>

      <div ref={scrollRef} aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
            <p className="text-sm font-medium text-foreground/80">No messages yet</p>
            <p className="mt-1 text-xs">What you and {trainerName} say appears here.</p>
          </div>
        ) : (
          entries.map((entry, index) => {
            const isUser = entry.role === "user";
            return (
              <div key={index} className={cn("flex flex-col gap-1.5", isUser && "items-end")}>
                <span className="text-xs text-foreground/70">{isUser ? "You" : trainerName}</span>
                <p
                  className={cn(
                    "max-w-[92%] rounded-[20px] px-3.5 py-2.5 text-[15px] leading-[22px] whitespace-pre-wrap",
                    isUser ? "bg-card ring-1 ring-border ring-inset" : "bg-muted",
                  )}
                >
                  {entry.text}
                </p>
              </div>
            );
          })
        )}

        {isSpeaking || isThinking ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden className="flex gap-1">
              {[0, 0.2, 0.4].map((delay) => (
                <span
                  key={delay}
                  style={{ animationDelay: `${delay}s` }}
                  className={cn("size-1 animate-pulse rounded-full", isSpeaking ? "bg-emerald-500" : "bg-amber-500")}
                />
              ))}
            </span>
            {trainerName} is {isSpeaking ? "speaking" : "thinking"}…
          </p>
        ) : null}
      </div>

      <form
        className="flex shrink-0 items-center gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <input
          type="text"
          value={inputText}
          disabled={disabled}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={disabled ? "Connecting to trainer…" : "Message the trainer…"}
          aria-label="Message the trainer"
          className="h-11 min-w-0 flex-1 rounded-full bg-card px-4 text-sm ring-1 ring-border outline-none ring-inset placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={disabled || !inputText.trim()}
          aria-label="Send message"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background outline-none transition-opacity hover:opacity-85 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-35"
        >
          <ArrowUp className="size-[18px]" />
        </button>
      </form>
    </aside>
  );
}
