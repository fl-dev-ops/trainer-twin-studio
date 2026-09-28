"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const KINDS = [
  { value: "bug", label: "Bug report" },
  { value: "feature", label: "Feature request" },
  { value: "other", label: "Something else" },
] as const;

type ReportKind = (typeof KINDS)[number]["value"];

export function ReportIssueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<ReportKind>("bug");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = message.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/issues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, message: trimmed, url: window.location.href }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setError(result?.error || "Could not submit the report");
        return;
      }
      toast.success("Thanks — your report has been logged.");
      setMessage("");
      setKind("bug");
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="dark sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Report an issue</DialogTitle>
          <DialogDescription>
            Tell us what went wrong or what you&apos;d like to see
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel>Type</FieldLabel>
              <div
                role="radiogroup"
                aria-label="Type"
                className="flex flex-wrap gap-2"
              >
                {KINDS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    onClick={() => setKind(option.value)}
                    aria-checked={kind === option.value}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      kind === option.value
                        ? "border-ring bg-muted font-medium text-foreground"
                        : "border-input text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="issue-message">What happened?</FieldLabel>
              <Textarea
                id="issue-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Describe the issue or your suggestion…"
                maxLength={5000}
                rows={5}
                aria-invalid={Boolean(error)}
                required
              />
              <FieldError>{error}</FieldError>
              <FieldDescription>{message.length}/5000</FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter className="mt-2 gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || trimmed.length < 5}>
              {submitting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  <span>Submitting…</span>
                </>
              ) : (
                <>
                  <Flag data-icon="inline-start" />
                  <span>Submit report</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
