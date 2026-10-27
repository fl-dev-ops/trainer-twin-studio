"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceAssistant } from "@livekit/components-react";
import { ArrowUp, X } from "lucide-react";
import type { Entry } from "@/lib/session-transcript";
import { cn } from "@/lib/utils";

export function SessionSidebar({
  entries,
  onSendMessage,
  onClose,
  disabled = false,
  className,
  speakerName = "Trainer",
  learnerName = "You",
}: {
  /** Who the AI is on this call: the trainer persona, or the role-play client. */
  speakerName?: string;
  learnerName?: string;
  entries: Entry[];
  onSendMessage?: (text: string) => void;
  onClose?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const voiceAssistant = useVoiceAssistant();
  const isSpeaking = voiceAssistant.state === "speaking";
  const isThinking = voiceAssistant.state === "thinking";

  const [inputText, setInputText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, isSpeaking, isThinking]);

  function handleSend() {
    if (disabled) return;
    const trimmed = inputText.trim();
    if (!trimmed) return;
    onSendMessage?.(trimmed);
    setInputText("");
  }

  return (
    <aside
      aria-label="Session chat"
      className={cn(
        "flex h-full min-h-0 w-[360px] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white text-neutral-900 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.15)]",
        className,
      )}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
        <h2 className="text-base font-medium">Chat</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close chat"
            className="grid size-8 place-items-center rounded-full text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <X className="size-4" />
          </button>
        )}
      </header>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center text-neutral-500">
            <p className="text-sm font-medium text-neutral-700">Conversation</p>
            <p className="mt-1 text-xs">Spoken dialogue and messages will appear here in real time.</p>
          </div>
        ) : (
          entries.map((entry, index) => {
            const isUser = entry.role === "user";
            return (
              <div key={index} className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
                <span className="px-0.5 text-xs text-neutral-500">{isUser ? learnerName : speakerName}</span>
                <div
                  className={cn(
                    "max-w-[90%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                    isUser ? "border border-neutral-200 bg-white" : "bg-neutral-100",
                  )}
                >
                  {entry.text}
                </div>
              </div>
            );
          })
        )}

        {(isSpeaking || isThinking) && (
          <div className="flex items-center gap-2 px-0.5 text-xs text-neutral-500">
            <div className="flex items-center gap-1">
              {[0, 0.2, 0.4].map((delay) => (
                <span
                  key={delay}
                  style={{ animationDelay: `${delay}s` }}
                  className={cn("size-1 animate-pulse rounded-full", isSpeaking ? "bg-emerald-500" : "bg-amber-500")}
                />
              ))}
            </div>
            <span>{isSpeaking ? "Speaking…" : "Thinking…"}</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-neutral-200 p-3">
        <input
          type="text"
          value={inputText}
          disabled={disabled}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          placeholder={disabled ? `Connecting to ${speakerName}…` : `Message ${speakerName}…`}
          className="h-11 min-w-0 flex-1 rounded-full border border-neutral-200 bg-white px-4 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-hidden disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !inputText.trim()}
          title="Send message"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </aside>
  );
}
