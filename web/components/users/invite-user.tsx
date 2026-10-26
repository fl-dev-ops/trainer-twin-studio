"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { MAX_INVITES, parseInviteEmails } from "@/lib/invite-emails";

/**
 * Invites one or more people (comma-separated) with a fixed role: team (runs the studio) or user (practises).
 * Nothing is sent while an entry is invalid. Failed invites stay in the box with their reason; onDone runs when all succeed.
 */
export function InviteUser({ organizationId, role, onDone }: { organizationId: string; role: "team" | "user"; onDone?: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const { emails, invalid } = parseInviteEmails(text);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid.length) return setErrors([`Not valid email addresses: ${invalid.join(", ")}`]);
    if (!emails.length) return setErrors(["Add at least one email address."]);
    if (emails.length > MAX_INVITES) return setErrors([`Invite up to ${MAX_INVITES} people at a time.`]);
    setBusy(true);
    setErrors([]);
    const failed: { email: string; message: string }[] = [];
    // One at a time: each invite runs Better Auth's checks (one org per person, one admin) and sends its email.
    for (const email of emails) {
      const invited = await authClient.organization.inviteMember({ email, role, organizationId });
      if (invited.error) failed.push({ email, message: invited.error.message ?? "Could not create the invite" });
    }
    setBusy(false);
    const sent = emails.length - failed.length;
    if (sent) {
      toast.success(sent === 1 ? "Invitation sent" : `${sent} invitations sent`);
      router.refresh();
    }
    setText(failed.map((item) => item.email).join(", "));
    setErrors(failed.map((item) => `${item.email}: ${item.message}`));
    if (!failed.length) onDone?.();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Textarea
        aria-label="Email addresses"
        placeholder="name@company.com, another@company.com"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setErrors([]);
        }}
        rows={4}
        autoFocus
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {invalid.length
            ? `${invalid.length} not valid · ${emails.length} ready`
            : emails.length
              ? `${emails.length} ${emails.length === 1 ? "person" : "people"} to invite`
              : "Separate emails with commas"}
        </p>
        <Button type="submit" disabled={busy || !emails.length}>
          {busy ? "Sending…" : emails.length > 1 ? `Send ${emails.length} invites` : "Send invite"}
        </Button>
      </div>
      {errors.length ? (
        <ul role="alert" className="grid gap-1 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
