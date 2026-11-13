/** Shared, image-free layout for team alerts. Keep the complete user message; shorten only the surrounding copy. */
import { renderEmailLayout } from "./layout";
import { detailsText, emailButton, emailDetails, emailLink, emailMessage, emailNote, emailParagraph, type EmailDetail } from "./components";

export type IssueReportEmailArgs = {
  to: string;
  cc: string[];
  kind: string;
  reporter: { name: string; email: string };
  org: string | null;
  message: string;
  pageUrl: string | null;
  sessionUrl: string | null;
  posthogEventUrl: string | null;
  replayUrl: string | null;
};

export function renderReportEmail(input: IssueReportEmailArgs, content: { subject: string; heading: string; introduction: string }) {
  const rows: EmailDetail[] = [["From", `${input.reporter.name || input.reporter.email}${input.reporter.name ? ` (${input.reporter.email})` : ""}`]];
  if (input.org) rows.push(["Organization", input.org]);
  let message = input.message;
  if (input.kind === "support") {
    const [subject, ...rest] = input.message.split(/\r?\n/);
    rows.push(["Subject", subject]);
    message = rest.join("\n").trimStart();
  } else rows.push(["Type", input.kind]);

  const links = [
    ["View session", input.sessionUrl], ["View replay", input.replayUrl],
    ["View page", input.pageUrl], ["View issue details", input.posthogEventUrl],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return {
    subject: content.subject,
    html: renderEmailLayout({
      title: content.heading, previewText: input.message.slice(0, 120),
      contentHtml: emailParagraph(content.introduction) + emailDetails(rows)
        + (message ? emailMessage(message) : "")
        + emailNote("Reply to this email to answer the reporter.")
        + links.map(([label, url], index) => index === 0 ? emailButton(label, url) : emailLink(label, url)).join(""),
    }),
    text: [content.heading, content.introduction, detailsText(rows), message, "Reply to this email to answer the reporter.", ...links.map(([label, url]) => `${label}: ${url}`)].filter(Boolean).join("\n\n"),
  };
}
