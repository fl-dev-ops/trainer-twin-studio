/**
 * A user's bug report, feature request or other issue. Saved by /api/issues, then emailed to the team by
 * alertIssueReport with reporter, organization, page/replay/session links; replies go to the reporter.
 */
import { renderReportEmail, type IssueReportEmailArgs } from "./report-shared";

export function issueReportEmail(input: IssueReportEmailArgs) {
  const where = input.org ? ` · ${input.org}` : "";
  return renderReportEmail(input, {
    subject: `Issue reported (${input.kind})${where} · ${input.reporter.name || input.reporter.email}`,
    heading: "Issue reported",
    introduction: "A new report needs your attention.",
  });
}
