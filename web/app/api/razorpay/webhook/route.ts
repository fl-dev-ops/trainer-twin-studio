import { purchasePaid, purchaseRefunded, PurchaseError } from "@/lib/credit-purchases";
import { verifyWebhookSignature } from "@/lib/razorpay";

/**
 * Razorpay's webhook (Dashboard › Webhooks: https://dash.trainertwin.com/api/razorpay/webhook, secret =
 * RAZORPAY_WEBHOOK_SECRET; events payment_link.paid, invoice.paid, refund.processed). A paid credit purchase adds its
 * credits; a refund takes its share back. Each happens once, however often Razorpay retries; anything else is
 * acknowledged and ignored. A 2xx tells Razorpay to stop retrying, so only a failure worth retrying returns 5xx.
 */

type Entity<T> = { entity: T } | undefined;
type Event = {
  event?: string;
  payload?: {
    payment_link?: Entity<{ id: string; notes?: Record<string, string> }>;
    invoice?: Entity<{ id: string }>;
    payment?: Entity<{ id: string; amount: number; currency: string }>;
    refund?: Entity<{ id: string; payment_id: string; amount: number; currency: string }>;
  };
};

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get("x-razorpay-signature"))) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  const body = JSON.parse(raw) as Event;
  const payment = body.payload?.payment?.entity;
  try {
    let result: unknown = null;
    if (body.event === "payment_link.paid" && body.payload?.payment_link && payment) {
      const link = body.payload.payment_link.entity;
      result = await purchasePaid({ razorpayId: link.id, purchaseId: link.notes?.purchaseId, paymentId: payment.id, amountPaid: payment.amount, currency: payment.currency });
    } else if (body.event === "invoice.paid" && body.payload?.invoice && payment) {
      result = await purchasePaid({ razorpayId: body.payload.invoice.entity.id, paymentId: payment.id, amountPaid: payment.amount, currency: payment.currency });
    } else if (body.event === "refund.processed" && body.payload?.refund) {
      const refund = body.payload.refund.entity;
      result = await purchaseRefunded({ refundId: refund.id, paymentId: refund.payment_id, amount: refund.amount, currency: refund.currency });
    } else {
      return Response.json({ ok: true, ignored: body.event ?? "unknown" });
    }
    if (!result) return Response.json({ ok: true, ignored: "not a credit purchase" });
    return Response.json({ ok: true, result });
  } catch (error) {
    // A payment that doesn't match its purchase won't match on a retry either: log it for a person, stop retries.
    if (error instanceof PurchaseError) {
      console.error(`[razorpay] ${body.event}: ${error.message}`);
      return Response.json({ ok: false, error: error.message });
    }
    throw error;
  }
}
