"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportIssueDialog } from "@/components/report-issue-dialog";

/**
 * Learner-only "Report an issue" trigger for the session top bar.
 * Self-contained: owns its dialog open state. Rendered only in the
 * learner session surface (SessionView with a sessionCode), never in
 * the admin studio chrome.
 */
export function ReportIssueButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Report an issue"
        title="Report an issue"
        className="rounded-full border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <Flag />
        <span className="hidden sm:inline">Report an issue</span>
      </Button>
      <ReportIssueDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
