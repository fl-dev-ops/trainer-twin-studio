"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle, MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Entry } from "@/lib/session-transcript";

export function TranscriptPanel({
  entries,
  coverage,
  preparing,
  onClose,
  className,
}: {
  entries: Entry[];
  coverage: Record<string, string>;
  preparing: boolean;
  onClose?: () => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const coverageEntries = Object.entries(coverage);

  return (
    <aside
      aria-label="Session transcript"
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_0_0_1px_var(--border),0_24px_64px_rgb(0_0_0/0.34)]",
        className,
      )}
    >
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2.5">
          <MessageSquareText aria-hidden="true" className="text-primary size-4" />
          <div>
            <h2 className="text-foreground text-sm font-semibold">Transcript</h2>
            <p className="text-[11px] text-muted-foreground">Session conversation</p>
          </div>
        </div>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close transcript"
            className="text-muted-foreground rounded-full"
          >
            <X />
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-full">
              <MessageSquareText aria-hidden="true" className="size-4" />
            </div>
            <p className="mt-3 text-sm font-medium">Conversation will appear here</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {preparing
                ? "Preparing the session — compiling context and indexing knowledge…"
                : "Spoken messages from you and the trainer are shown together."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((entry, index) => (
              <div key={index} className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm",
                    entry.role === "user" ? "bg-primary text-primary-foreground" : "border bg-background",
                  )}
                >
                  <div
                    className={cn(
                      "mb-0.5 text-[11px] font-medium",
                      entry.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {entry.role === "user" ? "You" : "Trainer"}
                  </div>
                  {entry.text}
                </div>
              </div>
            ))}
            {preparing && (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin" /> Preparing…
              </div>
            )}
          </div>
        )}
      </div>

      {coverageEntries.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-t p-3">
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Evidence coverage</h3>
          <ul className="flex flex-wrap gap-1.5">
            {coverageEntries.map(([key, status]) => (
              <li key={key}>
                <Badge
                  variant="outline"
                  className={cn(
                    status === "sufficient" && "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
                    status === "partial" && "border-amber-500/50 text-amber-600 dark:text-amber-400",
                    status === "unresolved" && "border-red-500/50 text-red-600 dark:text-red-400",
                    !["sufficient", "partial", "unresolved"].includes(status) && "text-muted-foreground",
                  )}
                >
                  {key}: {status}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
