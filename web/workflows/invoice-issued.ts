// Workflow: an invoice was issued (specs/billing.md rules 13–15, 12).
// Emails the invoice with its PDF; for the Paid plan, waits for the due date: a renewal still unpaid gets a reminder
// the day before and pauses the org once overdue, an upgrade still unpaid is cancelled. Started once per invoice by
// lib/billing/billing.ts (Meteroid's invoice.finalized webhook, an upgrade, a pack, the daily check); steps in
// ./steps/billing.ts.

import { sleep } from "workflow";
import { emailInvoice, handleOverdue, readInvoice, remind } from "./steps/billing";

const DAY_MS = 86_400_000;

/** Waits until `at`, unless it has already passed. */
async function until(at: Date) {
  if (at.getTime() > Date.now()) await sleep(at);
}

export async function invoiceIssued(invoiceId: string) {
  "use workflow";
  const invoice = await readInvoice(invoiceId);
  if (invoice.status === "void") return { status: "void" as const };
  await emailInvoice(invoiceId);
  if (invoice.kind !== "renewal" && invoice.kind !== "upgrade") return { status: "emailed" as const };
  const due = new Date(`${invoice.dueDate}T00:00:00.000Z`).getTime();
  if (invoice.kind === "renewal") {
    await until(new Date(due - DAY_MS));
    await remind(invoiceId);
  }
  await until(new Date(due + DAY_MS));
  return { status: await handleOverdue(invoiceId) };
}
