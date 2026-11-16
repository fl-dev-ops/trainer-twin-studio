"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { MessageFileCard } from "@/components/copilot-composer";
import { stripAttachments } from "@/lib/markers";
import { cn } from "@/lib/utils";

export function ConversationPortrait({ name, photoUrl = null, className }: { name: string; photoUrl?: string | null; className?: string }) {
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- avatar endpoint may redirect to a signed image
    return <img src={photoUrl} alt="" aria-hidden className={cn("object-cover object-[center_20%]", className)} />;
  }
  return <div aria-hidden className={cn("grid place-items-center bg-art-pastel font-semibold text-night/80", className)}>{name.charAt(0).toUpperCase()}</div>;
}

export function ConversationBubble({ from, children, className }: { from: "you" | "agent"; children: ReactNode; className?: string }) {
  return <p className={cn("w-fit max-w-full break-words rounded-2xl text-sm leading-5 whitespace-pre-wrap",
    from === "you" ? "self-end bg-card px-5 py-2.5 ring-1 ring-border ring-inset" : "bg-muted px-4 py-2.5", className)}>{children}</p>;
}

export type AttachedFiles = ReadonlyMap<string, { name: string; mediaType: string | null }>;
export function AttachedTurn({ text, files, className }: { text: string; files?: AttachedFiles; className?: string }) {
  const split = stripAttachments(text);
  return <div className="flex flex-col items-end gap-2">
    <div className="flex flex-wrap justify-end gap-2">
      {split.files.map(file => {
        const known = files?.get(file.id);
        return <MessageFileCard key={file.id} name={known?.name ?? file.name} mediaType={known?.mediaType ?? undefined}
          previewUrl={known?.mediaType?.startsWith("image/") ? `/api/uploads/${file.id}/view` : undefined} />;
      })}
    </div>
    {split.text.trim() ? <ConversationBubble from="you" className={className}>{split.text}</ConversationBubble> : null}
  </div>;
}

/** Follow new speech unless the reader has scrolled back to an earlier turn. */
export function ConversationScroll({ children, className }: { children: ReactNode; className?: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = viewport.current;
    if (el && follow.current) el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [children]);
  return <div ref={viewport} onScroll={() => {
    const el = viewport.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }} className={cn("mask-edge-y flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain", className)}>
    {children}
  </div>;
}
