import { useState, type FormEvent, type RefObject } from "react";
import { WidgetPortrait } from "./widget-portrait";
import { SwapText } from "./widget-text";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Free-limit card: explains the limit and lets the visitor leave an email and a note for the trainer. */
export function WidgetLimit({ trainer, photoUrl, reason, sentTo, noticeRef, onSend }: {
  trainer: string;
  photoUrl: string | null;
  reason?: string;
  sentTo?: string;
  noticeRef: RefObject<HTMLHeadingElement | null>;
  onSend: (email: string, message: string) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const sent = !!sentTo;
  const title = sent ? "Thanks, your note is on its way" : "Free call limit reached";
  const body = sent ? `${trainer} will get back to you at ${sentTo}.`
    : `${reason ?? "There aren’t enough free call minutes left right now."} Leave a note and ${trainer} will get back to you.`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const message = String(form.get("message") ?? "").trim();
    if (!emailPattern.test(email) || email.length > 254) { setProblem("Enter a valid email address."); return; }
    setProblem(undefined);
    setSending(true);
    try {
      await onSend(email, message);
    } catch {
      setProblem("We couldn’t send your note. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="tt-limit tt-stage">
      <div className="tt-intro-heading">
        <WidgetPortrait name={trainer} photoUrl={photoUrl} className="tt-intro-portrait" />
        <div>
          <SwapText as="h2" ref={noticeRef} tabIndex={-1} text={title} />
          <SwapText as="p" text={body} delay={60} />
        </div>
      </div>
      {!sent && <form className="tt-limit-form" noValidate onSubmit={submit}>
        <input className="tt-field" type="email" name="email" autoComplete="email" inputMode="email" placeholder="Your email"
          aria-label="Your email" maxLength={254} required aria-invalid={problem?.includes("email") || undefined}
          aria-describedby="tt-limit-problem" />
        <textarea className="tt-field" name="message" rows={3} maxLength={1000} placeholder={`Anything you’d like ${trainer} to know? (optional)`}
          aria-label={`Message for ${trainer}`} />
        <p className="tt-limit-problem" id="tt-limit-problem" role="alert" hidden={!problem}>{problem}</p>
        <button type="submit" className="tt-intro-button tt-limit-send" disabled={sending}>{sending ? "Sending…" : "Send note"}</button>
      </form>}
    </div>
  );
}
