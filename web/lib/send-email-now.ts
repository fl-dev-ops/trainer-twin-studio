import { sendOrgCreditsEmail, sendPersonEmail } from "@/lib/email";
import type { OutboundEmail } from "@/workflows/send-emails";

/** Sends one email now (the send-emails workflow's step, and its fallbacks in lib/queue-emails.ts). */
export function sendEmailNow(email: OutboundEmail, idempotencyKey?: string) {
  switch (email.kind) {
    case "person": return sendPersonEmail({ ...email.args, idempotencyKey });
    case "orgCredits": return sendOrgCreditsEmail({ ...email.args, idempotencyKey });
  }
}
