"use client";

import { useState } from "react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

const SUBJECT_MAX = 150;
const MESSAGE_MAX = 4800; // the subject, a blank line and this stay within /api/issues' 5000 characters

/**
 * The studio's "Support": a subject and a message, sent like a learner's "Report an issue" (/api/issues: saved, then
 * emailed to the team, who reply straight to the sender). `subject` pre-fills it, e.g. "Upgrade to a paid plan".
 */
export function SupportDialog({ open, onOpenChange, subject: initialSubject = "" }: { open: boolean; onOpenChange: (open: boolean) => void; subject?: string }) {
  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = subject.trim().length > 0 && message.trim().length >= 5;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/issues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "support",
          message: `${subject.trim()}\n\n${message.trim()}`,
          url: window.location.href,
          replayUrl: posthog.get_session_replay_url?.({ withTimestamp: true }) || null,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? "Could not send it; please try again.");
        return;
      }
      toast.success("Sent. We'll reply to your email.");
      setSubject(initialSubject);
      setMessage("");
      onOpenChange(false);
    } catch {
      setError("Could not send it; please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Contact support</DialogTitle>
          <DialogDescription>Ask us anything or tell us what went wrong. We&apos;ll reply to your email.</DialogDescription>
        </DialogHeader>
        <form onSubmit={send} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="support-subject">Subject</FieldLabel>
              <Input id="support-subject" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={SUBJECT_MAX} placeholder="What's it about?" required autoFocus />
            </Field>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="support-message">Message</FieldLabel>
              <Textarea id="support-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={MESSAGE_MAX} rows={6} placeholder="Tell us the details…" required />
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="brand" disabled={!ready || busy}>
              {busy ? <><Spinner data-icon="inline-start" /> Sending…</> : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
