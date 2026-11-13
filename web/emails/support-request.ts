/**
 * A studio Support request (including Request upgrade). Saved through /api/issues as kind support, then emailed
 * to the team by alertIssueReport; the message's first line is the subject and replies go to the logged-in user.
 */
import { renderReportEmail, type IssueReportEmailArgs } from "./report-shared";

export function supportRequestEmail(input: IssueReportEmailArgs) {
  const where = input.org ? ` · ${input.org}` : "";
  return renderReportEmail(input, {
    subject: `Support: ${input.message.split("\n")[0].slice(0, 120)}${where} · ${input.reporter.name || input.reporter.email}`,
    heading: "Support request",
    introduction: "A new support request needs your attention.",
  });
}
