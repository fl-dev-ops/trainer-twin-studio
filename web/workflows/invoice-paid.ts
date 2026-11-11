// Workflow: an invoice was paid (specs/billing.md rules 11, 17, 19, 21).
// Re-reads it from Meteroid (which sends invoice.paid a moment before its API shows it paid, so this waits for that),
// then: an upgrade puts the org on the Paid plan, a renewal unpauses it, a pack's credits come through Meteroid's
// wallet.funded; and one "payment received" email with the receipt and the invoice. Started once per invoice by
// lib/billing/billing.ts (Meteroid's invoice.paid webhook, the daily check); steps in ./steps/billing.ts.

import { sleep } from "workflow";
import { handlePaid } from "./steps/billing";

/** How long to wait for Meteroid's API to show the payment: 12 checks, 10 s apart. Not by then: the daily check. */
const PAID_CHECKS = 12;
const PAID_INTERVAL = "10s";

export async function invoicePaid(invoiceId: string) {
  "use workflow";
  for (let check = 0; check < PAID_CHECKS; check++) {
    const kind = await handlePaid(invoiceId);
    if (kind) return { status: "handled" as const, kind };
    await sleep(PAID_INTERVAL);
  }
  return { status: "not_paid" as const, kind: null };
}
