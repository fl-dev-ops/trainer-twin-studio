/** Email delivery and stable entry points. Templates live in emails/; callers/workflows keep using this module. */
import { Resend } from "resend";
import { otpEmail, type OtpEmailArgs } from "@/emails/otp";
import { personEmail, type PersonEmailArgs } from "@/emails/person";
import { orgCreditsEmail, type OrgCreditsEmailArgs } from "@/emails/org-credits";
import type { BillingEmailArgs } from "@/emails/billing-shared";
import { invoiceIssuedEmail } from "@/emails/invoice-issued";
import { invoiceReminderEmail } from "@/emails/invoice-reminder";
import { planPausedEmail } from "@/emails/plan-paused";
import { upgradeCancelledEmail } from "@/emails/upgrade-cancelled";
import { invoicePaidEmail } from "@/emails/invoice-paid";
import { issueReportEmail } from "@/emails/issue-report";
import { supportRequestEmail } from "@/emails/support-request";
import type { IssueReportEmailArgs } from "@/emails/report-shared";

export { personEmail, orgCreditsEmail };
export type { PersonEmailArgs, OrgCreditsEmailArgs, BillingEmailArgs };

const resendApiKey = process.env.RESEND_API_KEY;
export const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const DEFAULT_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "TrainerTwin <no-reply@trainertwin.com>";
const DEFAULT_REPLY_TO = "support@trainertwin.com";

export type SendEmailOptions = {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  /** Resend sends one email per key (24 h): a retried workflow step can't send it twice. */
  idempotencyKey?: string;
  /** Files sent with the email (billing: invoice and receipt PDFs). */
  attachments?: { filename: string; content: Buffer }[];
};

/** Development never sends email; other environments preserve Resend delivery and error handling. */
export async function sendEmail({
  to,
  cc,
  subject,
  html,
  text,
  from = DEFAULT_FROM_EMAIL,
  replyTo = DEFAULT_REPLY_TO,
  idempotencyKey,
  attachments,
}: SendEmailOptions) {
  if (process.env.NODE_ENV === "development") {
    console.info(`[Dev email] Skipped sending to ${Array.isArray(to) ? to.join(", ") : to}`);
    return { success: true, skipped: true };
  }
  if (!resend) {
    console.warn(
      `[Email] RESEND_API_KEY is not set. Skipped sending to ${Array.isArray(to) ? to.join(", ") : to}`,
    );
    return { success: false, error: "RESEND_API_KEY is not set" };
  }

  try {
    const result = await resend.emails.send({
      from,
      to,
      ...(cc ? { cc } : {}),
      replyTo,
      // One line: names in subjects come from people (practice rule 28).
      subject: subject.replace(/[\r\n]+/g, " ").trim(),
      html,
      text,
      ...(attachments?.length ? { attachments } : {}),
    }, idempotencyKey ? { idempotencyKey } : undefined);

    if (result.error) {
      console.error("[Email Error]:", result.error);
      return { success: false, error: result.error.message, status: result.error.statusCode };
    }

    return { success: true, data: result.data };
  } catch (error) {
    console.error("[Email Exception]:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending email",
    };
  }
}

/** Development sign-in uses a real OTP from the server terminal, never email, even with a configured key. */
export async function sendOtpEmail(args: OtpEmailArgs) {
  if (process.env.NODE_ENV === "development") {
    // Local testing still uses a real, expiring OTP; never expose it in an HTTP response.
    console.info(`[Dev sign-in] Code for ${args.to}: ${args.otp} (expires in 10 minutes)`);
    return { success: true };
  }
  return sendEmail({ to: args.to, ...otpEmail(args) });
}

export function sendPersonEmail(args: PersonEmailArgs) {
  return sendEmail({ to: args.to, ...personEmail(args), idempotencyKey: args.idempotencyKey });
}

export function sendOrgCreditsEmail(args: OrgCreditsEmailArgs) {
  return sendEmail({ to: args.to, ...orgCreditsEmail(args), idempotencyKey: args.idempotencyKey });
}

/** Billing emails keep their own sender; replies go to support (Billing rule 21). */
export const BILLING_FROM_EMAIL = process.env.BILLING_FROM_EMAIL || "TrainerTwin Billing <billing@trainertwin.com>";

const BILLING_TEMPLATES = {
  issued: invoiceIssuedEmail,
  reminder: invoiceReminderEmail,
  paused: planPausedEmail,
  upgrade_cancelled: upgradeCancelledEmail,
  paid: invoicePaidEmail,
};

/** Render the event's own template without changing the billing callers' interface. */
export function billingEmail(args: BillingEmailArgs) {
  return BILLING_TEMPLATES[args.event](args);
}

export function sendBillingEmail(input: { to: string[]; args: BillingEmailArgs; attachments?: { filename: string; content: Buffer }[]; idempotencyKey: string }) {
  return sendEmail({ to: input.to, from: BILLING_FROM_EMAIL, ...billingEmail(input.args), attachments: input.attachments, idempotencyKey: input.idempotencyKey });
}

/** Issue and support alerts share delivery, including CC and the reporter's reply-to address. */
export async function sendIssueReportEmail(input: IssueReportEmailArgs) {
  const rendered = input.kind === "support" ? supportRequestEmail(input) : issueReportEmail(input);
  return sendEmail({ to: input.to, cc: input.cc, ...rendered, replyTo: input.reporter.email });
}
