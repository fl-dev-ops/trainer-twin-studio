"use client";

import { followEmailProgress } from "@/lib/follow-email-progress";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DurationInput, parseMinutes } from "@/components/duration-input";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_LEARNER_MINUTES, MAX_LEARNER_MINUTES } from "@/lib/minutes-config";
import { MAX_INVITES, parseInviteEmails } from "@/lib/invite/emails";
import { useRefresh } from "@/lib/use-refresh";

/**
 * Invites one or more people (comma-separated) with a fixed role: team (runs the studio) or user (practises). Users
 * also get their starting credits from the org's balance (all or nothing, checked before anyone is invited).
 * Nothing is sent while an entry is invalid. Failed invites stay in the box with their reason; onDone runs when all succeed.
 */
export function InviteUser({ organizationId, role, onDone }: { organizationId: string; role: "team" | "user"; onDone?: () => void }) {
  const refresh = useRefresh();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const { emails, invalid } = parseInviteEmails(text);
  const [credits, setCredits] = useState(String(DEFAULT_LEARNER_MINUTES));
  const parsedCredits = parseMinutes(credits);
  const startingMinutes = role === "user" && parsedCredits !== null && parsedCredits <= MAX_LEARNER_MINUTES ? parsedCredits : null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid.length) return setErrors([`Not valid email addresses: ${invalid.join(", ")}`]);
    if (!emails.length) return setErrors(["Add at least one email address."]);
    if (emails.length > MAX_INVITES) return setErrors([`Invite up to ${MAX_INVITES} people at a time.`]);
    if (role === "user" && startingMinutes === null) return setErrors([`Starting credits: a whole number from 1 to ${MAX_LEARNER_MINUTES}.`]);
    setBusy(true);
    setErrors([]);
    const failed: { email: string; message: string }[] = [];
    if (role === "user") {
      // Credits first, all or nothing (server), then one invite each.
      try {
        const result = await api.minutes.invite.mutate({ emails, minutes: startingMinutes! });
        failed.push(...result.failed);
        if (result.emailProgress) void followEmailProgress(result.emailProgress, result.emailsQueued);
        else if (result.emailFailures) toast.warning(`${result.emailFailures} invite email(s) could not be sent.`);
      } catch (error) {
        setBusy(false);
        return setErrors([error instanceof Error ? error.message : "Could not create the invites"]);
      }
    } else {
      // One at a time: each invite runs Better Auth's checks (one org per person, one admin) and sends its email.
      for (const email of emails) {
        const invited = await authClient.organization.inviteMember({ email, role, organizationId });
        if (invited.error) failed.push({ email, message: invited.error.message ?? "Could not create the invite" });
      }
    }
    setBusy(false);
    const sent = emails.length - failed.length;
    if (sent) {
      toast.success(sent === 1 ? "Invitation sent" : `${sent} invitations sent`);
      refresh();
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
      {role === "user" ? (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="invite-credits" className="flex flex-col text-sm font-medium">
            Starting credits
            <span className="text-xs font-normal text-muted-foreground">Each, from your organization&apos;s balance. 1 credit = 1 min.</span>
          </label>
          <DurationInput id="invite-credits" value={credits} onChange={setCredits} />
        </div>
      ) : null}
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
