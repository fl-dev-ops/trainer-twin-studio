"use client";

import { useEffect, useState } from "react";
import { AssignComposer } from "@/components/assign-composer";
import { useOrgCopy } from "@/components/org-type-provider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

type Recipients = { memberEmails: string[]; pendingEmails: string[] };

/** Sends practice links for a published scenario from the scenario list. */
export function AssignDialog({
  slug,
  name,
  open,
  onOpenChange,
}: {
  slug: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const copy = useOrgCopy();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign {copy.scenarioLower}</DialogTitle>
          <DialogDescription>
            {name}. Comma-separated emails. Each learner receives their practice link.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so learners are re-read every time the dialog opens. */}
        {open && <AssignBody slug={slug} onSent={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function AssignBody({ slug, onSent }: { slug: string; onSent: () => void }) {
  const [recipients, setRecipients] = useState<Recipients | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/role-play/${encodeURIComponent(slug)}/assignments`)
      .then(async (response) => {
        const result = await response.json().catch(() => null) as (Recipients & { error?: string }) | null;
        if (!response.ok || !result) throw new Error(result?.error ?? "Could not load learners");
        if (!cancelled) setRecipients({ memberEmails: result.memberEmails, pendingEmails: result.pendingEmails });
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load learners");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!recipients) return <div className="grid place-items-center py-6"><Spinner /></div>;
  return (
    <AssignComposer
      slug={slug}
      memberEmails={recipients.memberEmails}
      pendingEmails={recipients.pendingEmails}
      onSent={onSent}
    />
  );
}
