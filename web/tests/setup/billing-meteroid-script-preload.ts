import { grpcReply, seller, sellerReply } from "./billing-meteroid-fixture";

const webhookUrl = "https://dash.test/api/meteroid/webhook";
const events = ["wallet.funded", "wallet.debited", "wallet.depleted", "wallet.recovered", "credit_grant.expired", "invoice.finalized", "invoice.paid", "invoice.voided", "subscription.cancelled", "subscription.ended"];
const replies: Record<string, unknown> = {
  "/product_families": { data: [{ id: "family" }] },
  "/plans?per_page=100": { data: [{ id: "paid", name: "Paid", status: "ACTIVE" }] },
  "/credit-units": { data: [{ id: "mins", code: "MINS", product_id: "packs" }] },
  "/credit-units/mins/prices": { data: [{ currency: "USD", unit_price: "0.25", archived_at: null }] },
  "/customers?per_page=1": { data: [{ invoicing_entity_id: "entity-default" }] },
  "/webhooks/endpoints": { data: [{ id: "webhook", url: webhookUrl, event_types: events }] },
};
// Run the real top-level script, but refuse all network requests except the explicit fake tenant calls.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  console.error(`[fake Meteroid] ${method} ${url.pathname}${url.search}`);
  if (url.origin === "https://meteroid.test" && method === "GET" && `${url.pathname}${url.search}` in replies) return Response.json(replies[`${url.pathname}${url.search}`]);
  if (url.origin === "https://meteroid-grpc.test") {
    if (url.pathname.endsWith("/GetInvoicingEntity")) {
      const mode = process.env.BILLING_SETUP_SELLER_FIXTURE;
      if (mode === "unavailable") return new Response(null, { status: 503 });
      return new Response(sellerReply({ ...seller, ...(mode === "missing-gstin" ? { gstin: "" } : mode === "missing-name" ? { name: "" } : {}) }));
    }
    if (url.pathname.endsWith("/UpdateInvoicingEntity") && method === "POST") return new Response(grpcReply());
  }
  throw new Error(`Unexpected script network request: ${method} ${url}`);
}) as typeof fetch;
