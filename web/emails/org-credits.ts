/**
 * Credits added to an organization's wallet. Sent to its enabled admin after Meteroid grants/purchases are synced;
 * shows the amount, reason, new balance, expiry and Usage link (one announcement per grant).
 */
import { renderEmailLayout } from "./layout";
import { plural } from "./helpers";
import { detailsText, emailButton, emailDetails, emailNote, emailParagraph, type EmailDetail } from "./components";

export type OrgCreditsEmailArgs = {
  to: string;
  orgName: string;
  added: number;
  balance: number;
  /** Formatted ("10 Nov 2027"); none = no expiry. */
  expires?: string | null;
  reason?: string | null;
  creditsUrl: string;
  idempotencyKey?: string;
};

export function orgCreditsEmail(args: OrgCreditsEmailArgs) {
  const subject = `${plural(args.added, "credit")} added to ${args.orgName}`;
  const rows: EmailDetail[] = [
    ["Organization", args.orgName],
    ["Credits added", plural(args.added, "credit")],
    ["New balance", plural(args.balance, "credit")],
  ];
  if (args.reason) rows.push(["Reason", args.reason]);
  rows.push(["Expires", args.expires ?? "Never"]);
  return {
    subject,
    html: renderEmailLayout({
      title: "Credits added", previewText: subject,
      contentHtml: emailParagraph("Your organization's credits are ready to use.") + emailDetails(rows)
        + emailNote("1 credit = 1 minute of practice.") + emailButton("View usage", args.creditsUrl),
    }),
    text: `Credits added\n\n${detailsText(rows)}\n\n1 credit = 1 minute of practice.\n\nView usage: ${args.creditsUrl}`,
  };
}
