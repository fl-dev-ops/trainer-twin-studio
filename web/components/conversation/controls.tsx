"use client";

import { useId, useState, type ButtonHTMLAttributes } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Shared twin/role-play control geometry; callers keep their own actions and availability policy. */
export function CallControlButton({ className, title, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} title={title ?? props["aria-label"]} className={cn(
    "grid size-10 shrink-0 place-items-center rounded-full border bg-muted outline-none transition-colors hover:bg-border focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:size-[54px] [&_svg]:size-[22px]",
    className,
  )} />;
}

/** One message form for both call screens; no session or transcript state lives here. */
export function CallComposer({ onSend, name, disabled = false, onClose, autoFocus = false }: {
  onSend: (text: string) => void | Promise<void>;
  name: string;
  disabled?: boolean;
  onClose?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  return <form className="relative flex w-full max-w-[440px] items-center gap-2 rounded-full border bg-card p-1.5 pl-4"
    onSubmit={async event => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || disabled || sending) return;
      setSending(true);
      try { await onSend(text); setDraft(""); }
      catch { toast.error("That message was not sent. Try again."); }
      finally { setSending(false); }
    }}>
    <label htmlFor={id} className="sr-only">Message {name}</label>
    <input id={id} autoFocus={autoFocus} autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => event.key === "Escape" && onClose?.()} placeholder={`Type a message to ${name}`}
      disabled={disabled || sending} maxLength={2000}
      className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:opacity-60 sm:text-sm" />
    <button type="submit" aria-label="Send message" disabled={disabled || sending || !draft.trim()}
      className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40">
      {sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
    </button>
  </form>;
}
