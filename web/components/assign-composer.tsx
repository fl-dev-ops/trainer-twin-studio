"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type EmailKind = "invalid" | "member" | "pending" | "unknown";

function parseEmails(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function BadgeChip({
  email,
  kind,
  onRemove,
}: {
  email: string;
  kind: EmailKind;
  onRemove: () => void;
}) {
  const tone =
    kind === "invalid"
      ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
      : kind === "pending"
        ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
        : "border-border bg-muted/40 text-foreground";
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <span className="truncate">{email}</span>
      {kind === "invalid" && <span className="text-[10px] font-medium">invalid</span>}
      {kind === "pending" && <span className="text-[10px] font-medium">pending</span>}
      <button
        type="button"
        aria-label={`Remove ${email}`}
        className="shrink-0 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** Comma-separated email input that sends practice links for one scenario, asking before re-sending pending ones. */
export function AssignComposer({
  slug,
  memberEmails,
  pendingEmails,
  disabled = false,
  onSent,
}: {
  slug: string;
  memberEmails: string[];
  pendingEmails: string[];
  disabled?: boolean;
  onSent?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [badges, setBadges] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const memberSet = new Set(memberEmails.map((email) => email.toLowerCase()));
  const pendingSet = new Set(pendingEmails.map((email) => email.toLowerCase()));

  function emailKind(email: string): EmailKind {
    if (!EMAIL_RE.test(email)) return "invalid";
    if (!memberSet.has(email)) return "unknown";
    return pendingSet.has(email) ? "pending" : "member";
  }

  function commitDraft() {
    const parsed = parseEmails(draft);
    if (parsed.length === 0) return;
    setDraft("");
    setBadges((current) => [...current, ...parsed.filter((e) => !current.includes(e))]);
  }

  const submittedEmails = [...new Set([...badges, ...parseEmails(draft)])];
  const hasInvalid = submittedEmails.some((email) => emailKind(email) === "invalid");
  const pendingSelected = submittedEmails.filter((email) => emailKind(email) === "pending");

  async function submit(resendPending?: "send" | "ignore") {
    setSaving(true);
    try {
      const response = await fetch(
        `/api/role-play/${encodeURIComponent(slug)}/assignments`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails: submittedEmails, resendPending: resendPending ?? "ignore" }),
        },
      );
      const result = await response.json().catch(() => null) as {
        added?: number;
        resent?: number;
        skipped?: number;
        emailFailures?: number;
        error?: string;
      } | null;
      if (!response.ok || !result || result.error) {
        throw new Error(result?.error ?? "Practice links could not be sent");
      }

      setBadges([]);
      setDraft("");
      const parts: string[] = [];
      if (result.added) parts.push(`${result.added} learner${result.added === 1 ? "" : "s"} assigned`);
      if (result.resent) parts.push(`${result.resent} practice link${result.resent === 1 ? "" : "s"} resent`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      if (parts.length === 0) {
        toast.info("Nothing to send");
      } else if (result.emailFailures) {
        toast.warning(`${parts.join(" · ")}, but ${result.emailFailures} email${result.emailFailures === 1 ? "" : "s"} could not be sent.`);
      } else {
        toast.success(parts.join(" · "));
      }
      router.refresh();
      onSent?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Practice links could not be sent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-3">
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {badges.map((email) => (
              <BadgeChip
                key={email}
                email={email}
                kind={emailKind(email)}
                onRemove={() =>
                  setBadges((current) => current.filter((item) => item !== email))
                }
              />
            ))}
          </div>
        )}
        <Textarea
          placeholder="name@company.com, another@company.com"
          value={draft}
          disabled={saving || disabled}
          onChange={(e) => {
            const value = e.target.value;
            if (value.endsWith(",")) commitDraft();
            else setDraft(value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
        />
        <Button
          className="w-full"
          size="sm"
          disabled={submittedEmails.length === 0 || hasInvalid || saving || disabled}
          onClick={() =>
            pendingSelected.length > 0 ? setConfirmOpen(true) : submit()
          }
        >
          <Send data-icon="inline-start" /> {saving ? "Sending…" : "Send practice links"}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Already assigned</DialogTitle>
            <DialogDescription>
              {pendingSelected.length === 1
                ? "This learner already has a pending assignment that hasn't been started."
                : `${pendingSelected.length} learners already have pending assignments that haven't been started.`}{" "}
              Send the practice link again?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            {pendingSelected.map((email) => (
              <span key={email} className="text-xs text-muted-foreground">
                {email}
              </span>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setConfirmOpen(false);
                  submit("ignore");
                }}
              >
                Ignore
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  setConfirmOpen(false);
                  submit("send");
                }}
              >
                {saving ? "Sending…" : "Yes, send link"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
