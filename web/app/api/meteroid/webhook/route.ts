import { verifyWebhook } from "@/lib/meteroid";
import { orgOfCustomer } from "@/lib/org-credits";
import { scheduleOrgSync } from "@/lib/schedule-org-credits";

/**
 * Meteroid's webhook (Meteroid › Webhooks: https://dash.trainertwin.com/api/meteroid/webhook, secret =
 * METEROID_WEBHOOK_SECRET). When an org's credits change in Meteroid (minutes granted or bought, expired, spent), the
 * org's copy is read again (workflows/org-credits.ts). Anything else, or a customer that isn't an org, is
 * acknowledged and ignored. A 2xx tells Meteroid to stop retrying.
 */

const CREDIT_EVENTS = new Set(["wallet.funded", "wallet.debited", "wallet.depleted", "wallet.recovered", "credit_grant.expired"]);

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyWebhook(raw, request.headers)) return Response.json({ error: "Invalid signature" }, { status: 401 });
  const event = JSON.parse(raw) as { type?: string; customer_id?: string; data?: { customer_id?: string } };
  if (!event.type || !CREDIT_EVENTS.has(event.type)) return Response.json({ ok: true, ignored: event.type ?? "unknown" });
  const customerId = event.customer_id ?? event.data?.customer_id;
  const orgId = customerId ? await orgOfCustomer(customerId) : null;
  if (!orgId) return Response.json({ ok: true, ignored: "not an org" });
  await scheduleOrgSync(orgId);
  return Response.json({ ok: true, synced: orgId });
}
