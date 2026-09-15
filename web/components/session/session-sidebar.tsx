"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceAssistant } from "@livekit/components-react";
import { ChevronRight, Keyboard, Send } from "lucide-react";
import type { Entry } from "@/lib/session-transcript";
import { cn } from "@/lib/utils";

export function SessionSidebar({
  entries,
  onSendMessage,
  onClose,
  disabled = false,
  className,
}: {
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
  const [inputVisible, setInputVisible] = useState(true);
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
        "flex h-full min-h-0 w-[360px] flex-col overflow-hidden rounded-2xl border border-white/[0.035] bg-[#17191f] shadow-[0_16px_40px_rgba(0,0,0,0.5)]",
        className,
      )}
    >
      {/* Header: Chevron + Chat Tab + Input Visibility Toggle */}
      <header className="flex h-13 shrink-0 items-center justify-between px-4">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            title="Collapse sidebar"
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        ) : (
          <div className="size-7" />
        )}

        <div className="relative flex items-center gap-2 font-semibold text-foreground text-sm">
          <span>Chat</span>
          <span className="rounded-full border border-white/10 bg-[#282c35] px-2 py-0.5 font-bold text-[11px] text-gray-300">
            {entries.length}
          </span>
          <div className="absolute -bottom-4 right-0 left-0 h-0.5 rounded-full bg-gray-400" />
        </div>

        <button
          type="button"
          onClick={() => setInputVisible((v) => !v)}
          title="Toggle message input bar"
          className={cn(
            "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground",
            inputVisible && "text-foreground",
          )}
        >
          <Keyboard className="size-4" />
        </button>
      </header>

      {/* Messages Stream */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pr-1">
          {entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
              <p className="font-medium text-sm text-foreground/80">Interview conversation</p>
              <p className="mt-1 text-xs">Spoken dialogue and messages will appear here in real time.</p>
            </div>
          ) : (
            entries.map((entry, index) => {
              const isUser = entry.role === "user";
              return (
                <div key={index} className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
                  <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                    <strong className="font-semibold text-foreground/90">{isUser ? "You" : "Vasanth"}</strong>
                  </div>
                  <div
                    className={cn(
                      "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                      isUser
                        ? "rounded-tr-xs bg-[#2b303b] text-white shadow-md"
                        : "rounded-tl-xs bg-[#1d2026] text-gray-200",
                    )}
                  >
                    {entry.text}
                  </div>
                </div>
              );
            })
          )}

          {/* Simple Status Indicator: Speaking… or Thinking… */}
          {isSpeaking && (
            <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="size-1 animate-pulse rounded-full bg-emerald-400" />
                <span className="size-1 animate-pulse rounded-full bg-emerald-400 [animation-delay:0.2s]" />
                <span className="size-1 animate-pulse rounded-full bg-emerald-400 [animation-delay:0.4s]" />
              </div>
              <span>Speaking…</span>
            </div>
          )}

          {isThinking && (
            <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="size-1 animate-pulse rounded-full bg-amber-400" />
                <span className="size-1 animate-pulse rounded-full bg-amber-400 [animation-delay:0.2s]" />
                <span className="size-1 animate-pulse rounded-full bg-amber-400 [animation-delay:0.4s]" />
              </div>
              <span>Thinking…</span>
            </div>
          )}
        </div>

        {/* Message Input Box */}
        {inputVisible && (
          <div className="mt-3 flex shrink-0 items-center gap-2 rounded-full bg-white/[0.04] p-1.5 px-3">
            <input
              type="text"
              value={inputText}
              disabled={disabled}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSend();
              }}
              placeholder={disabled ? "Connecting to trainer…" : "Message the trainer…"}
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-muted-foreground focus:outline-hidden disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || !inputText.trim()}
              title="Send message"
              className="grid size-7 place-items-center rounded-full bg-[#374151] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Send className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
