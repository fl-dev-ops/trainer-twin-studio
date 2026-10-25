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
        className="h-9 rounded-full px-4 text-[13px] font-medium"
      >
        <Flag data-icon="inline-start" />
        Report an issue
      </Button>
      <ReportIssueDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
