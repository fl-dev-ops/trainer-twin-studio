"use client";

import { useEffect, useRef, useState } from "react";
import { Chat } from "@livekit/components-react";
import { MessageSquareText, MessagesSquare, X, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Entry } from "@/lib/session-transcript";

export function SessionSidebar({
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
  const [activeTab, setActiveTab] = useState<string>("transcript");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTab === "transcript") {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [entries, activeTab]);

  const coverageEntries = Object.entries(coverage);

  return (
    <aside
      aria-label="Session sidebar"
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_0_0_1px_var(--border),0_24px_64px_rgb(0_0_0/0.34)]",
        className,
      )}
    >
      <Tabs
        value={activeTab}
        onValueChange={(val) => val && setActiveTab(val)}
        className="flex h-full min-h-0 flex-col"
      >
        <header className="flex shrink-0 items-center justify-between border-b px-3 py-2.5">
          <TabsList className="h-8">
            <TabsTrigger value="transcript" className="gap-1.5 text-xs">
              <MessageSquareText className="size-3.5" />
              Transcript
            </TabsTrigger>
            <TabsTrigger value="chat" className="gap-1.5 text-xs">
              <MessagesSquare className="size-3.5" />
              Chat
            </TabsTrigger>
          </TabsList>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close panel"
              className="size-7 rounded-full text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          )}
        </header>

        <TabsContent value="transcript" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <MessageSquareText aria-hidden="true" className="size-4" />
                </div>
                <p className="mt-3 text-sm font-medium">Conversation will appear here</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {preparing
                    ? "Preparing the session — compiling context and indexing knowledge…"
                    : "Spoken messages from you and the trainer are captured in real-time."}
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
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" /> Preparing…
                  </div>
                )}
              </div>
            )}
          </div>

          {coverageEntries.length > 0 && (
            <footer className="border-t bg-muted/40 p-3">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">Topic coverage</div>
              <div className="flex flex-wrap gap-1.5">
                {coverageEntries.map(([topic, status]) => (
                  <Badge
                    key={topic}
                    variant={status === "covered" ? "default" : "secondary"}
                    className="text-[11px]"
                  >
                    {topic}
                  </Badge>
                ))}
              </div>
            </footer>
          )}
        </TabsContent>

        <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden p-2">
          <Chat className="h-full w-full" />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
