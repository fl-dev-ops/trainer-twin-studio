/** Billing inputs and shared detail rows/payment guidance. Each event has its own short title and message. */
import { renderEmailLayout } from "./layout";
import { detailsText, emailButton, emailDetails, emailLink, emailNote, emailParagraph, type EmailDetail } from "./components";

export type BillingEmailArgs = {
  event: "issued" | "reminder" | "paused" | "upgrade_cancelled" | "paid";
  orgName: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  /** What the invoice is for: "TrainerTwin Paid plan, 3 Dec – 2 Jan", "Minute pack: 100 credits". */
  description: string;
  billingUrl: string;
  /** Razorpay's payment page for the invoice: a Pay now button (specs/billing.md rule 28). */
  payUrl?: string | null;
  /** Paid emails: what the payment did ("Your organization is now on the Paid plan."). */
  outcome?: string | null;
};

export function renderBillingEmail(args: BillingEmailArgs, content: { subject: string; title: string; message: string; note?: string }) {
  const payable = args.event === "issued" || args.event === "reminder" || args.event === "paused";
  const rows: EmailDetail[] = [
    ["Organization", args.orgName], ["Invoice", args.invoiceNumber], ["For", args.description],
    [args.event === "paid" ? "Amount paid (tax included)" : "Amount (tax included)", args.amount],
  ];
  if (args.event !== "paid") rows.push(["Due date", args.dueDate]);
  const payText = payable
    ? args.payUrl ? `Pay online: ${args.payUrl}` : `To pay invoice ${args.invoiceNumber}, reply to this email and we'll send you a payment link.`
    : "";
  const outcome = args.event === "paid" ? args.outcome : null;
  const html = renderEmailLayout({
    title: content.title, previewText: content.subject,
    contentHtml: emailParagraph(content.message) + emailDetails(rows)
      + (outcome ? emailParagraph(outcome) : "")
      + (content.note ? emailNote(content.note) : "")
      + (payable && args.payUrl
        ? emailButton(`Pay ${args.amount} now`, args.payUrl) + emailLink("View billing", args.billingUrl)
        : emailButton("View billing", args.billingUrl) + (payText ? emailNote(payText) : "")),
  });
  return { subject: content.subject, html, text: [content.title, content.message, detailsText(rows), outcome, content.note, payText, `View billing: ${args.billingUrl}`].filter(Boolean).join("\n\n") };
}
