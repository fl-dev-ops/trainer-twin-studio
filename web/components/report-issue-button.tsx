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
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Report an issue"
        title="Report an issue"
        className="text-white/80 hover:bg-white/10 hover:text-white"
      >
        Report an issue
        <Flag />
      </Button>
      <ReportIssueDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
