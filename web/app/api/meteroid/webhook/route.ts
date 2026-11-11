import { paidSubscriptionEnded, invoiceVoided, syncInvoice } from "@/lib/billing/billing";
import { verifyWebhook } from "@/lib/meteroid";
import { orgOfCustomer } from "@/lib/org-credits";
import { scheduleOrgSync } from "@/lib/schedule-org-credits";

/**
 * Meteroid's webhook (Meteroid › Webhooks: https://dash.trainertwin.com/api/meteroid/webhook, secret =
 * METEROID_WEBHOOK_SECRET; events set by scripts/meteroid-billing-setup.ts).
 * - Credits changed (granted or bought, expired, spent): the org's copy is read again (workflows/sync-org-credits.ts).
 * - An invoice issued or paid: the app's copy is read and its workflow started, once (lib/billing/billing.ts,
 *   specs/billing.md rule 24); voided: no more reminders.
 * - The org's Paid subscription cancelled or ended: back to Trial (rule 18).
 * Anything else, or a customer that isn't an org, is acknowledged and ignored. A 2xx tells Meteroid to stop retrying;
 * an error (Meteroid unreachable while reading the invoice) makes it retry.
 */

const CREDIT_EVENTS = new Set(["wallet.funded", "wallet.debited", "wallet.depleted", "wallet.recovered", "credit_grant.expired"]);
const INVOICE_EVENTS = new Set(["invoice.finalized", "invoice.paid"]);
const SUBSCRIPTION_ENDED = new Set(["subscription.cancelled", "subscription.ended"]);

/** Meteroid 2.2.1 sends the event's fields flat (`invoice_id` beside `type`); newer versions nest them in `data`. */
type Fields = { customer_id?: string; invoice_id?: string; subscription_id?: string };
type Event = Fields & { type?: string; data?: Fields };

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyWebhook(raw, request.headers)) return Response.json({ error: "Invalid signature" }, { status: 401 });
  let event: Event;
  try {
    event = JSON.parse(raw) as Event;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const type = event.type ?? "unknown";
  // A Paid subscription ending is found by its id (only an org's Paid subscription matches), customer or not.
  const subscriptionId = event.subscription_id ?? event.data?.subscription_id;
  if (SUBSCRIPTION_ENDED.has(type) && subscriptionId) {
    return Response.json({ ok: true, subscription: subscriptionId, backToTrial: await paidSubscriptionEnded(subscriptionId) });
  }
  const customerId = event.customer_id ?? event.data?.customer_id;
  const orgId = customerId ? await orgOfCustomer(customerId) : null;
  if (!orgId) return Response.json({ ok: true, ignored: CREDIT_EVENTS.has(type) || INVOICE_EVENTS.has(type) ? "not an org" : type });

  if (CREDIT_EVENTS.has(type)) {
    await scheduleOrgSync(orgId);
    return Response.json({ ok: true, synced: orgId });
  }
  const invoiceId = event.invoice_id ?? event.data?.invoice_id;
  if (INVOICE_EVENTS.has(type) && invoiceId) {
    // Meteroid sends invoice.paid a moment before its API shows the invoice paid: the paid workflow waits for it.
    const row = await syncInvoice(invoiceId, orgId, type === "invoice.paid");
    return Response.json({ ok: true, invoice: invoiceId, status: row?.status ?? "ignored" });
  }
  if (type === "invoice.voided" && invoiceId) {
    await invoiceVoided(invoiceId);
    return Response.json({ ok: true, invoice: invoiceId, status: "void" });
  }
  return Response.json({ ok: true, ignored: type });
}
