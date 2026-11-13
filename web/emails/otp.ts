/**
 * Email sign-in code. Sent by Better Auth only for an existing account requesting sign-in;
 * the six-digit code expires in 10 minutes. Local terminal-only delivery stays in lib/email.ts.
 */
import { renderEmailLayout } from "./layout";
import { emailCode, emailNote, emailParagraph } from "./components";

export type OtpEmailArgs = { to: string; otp: string; purpose?: string };

export function otpEmail({ otp, purpose = "Sign In" }: OtpEmailArgs) {
  const subject = `Your TrainerTwin ${purpose} code: ${otp}`;
  const title = purpose === "Sign In" ? "Your sign-in code" : "Your verification code";
  return {
    subject,
    html: renderEmailLayout({
      title, previewText: "Your code expires in 10 minutes.",
      contentHtml: emailParagraph(`Enter this code to complete your ${purpose.toLowerCase()}.`)
        + emailCode(otp)
        + emailNote("This code expires in 10 minutes. If you didn't request it, ignore this email."),
    }),
    text: `${title}: ${otp}\n\nThis code expires in 10 minutes. If you didn't request it, ignore this email.`,
  };
}
