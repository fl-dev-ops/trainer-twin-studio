import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createPackInvoice, createPaidSubscription, encodeProto, invoicePdf, meteroidGrpc, toInvoice } from "@/lib/billing/meteroid";

const grpc = process.env.METEROID_GRPC_URL;
const server = setupServer();
beforeAll(() => { process.env.METEROID_GRPC_URL = "https://meteroid-grpc.test/"; server.listen({ onUnhandledRequest: "error" }); });
afterEach(() => server.resetHandlers());
afterAll(() => { server.close(); if (grpc === undefined) delete process.env.METEROID_GRPC_URL; else process.env.METEROID_GRPC_URL = grpc; });

const raw = { id: "inv-1", invoice_number: "INV-1", status: "FINALIZED", payment_status: "PAID", invoice_type: "RECURRING", customer_id: "customer", subscription_id: "sub", total: 30000, tax_amount: 4576, currency: "USD", finalized_at: "2026-11-01T12:00:00Z", due_date: "2026-11-03", invoice_date: "2026-11-01", paid_at: "2026-11-02T10:00:00Z", line_items: [{ name: "Paid plan", quantity: "1", start_date: "2026-11-01", end_date: "2026-12-01" }], transactions: [{ provider_transaction_id: "bank-ref", status: "SETTLED", payment_type: "PAYMENT" }] };

test("REST Invoice maps dates, period, paid references and USD cents", () => {
  expect(toInvoice(raw)).toEqual({ id: "inv-1", number: "INV-1", status: "FINALIZED", paymentStatus: "PAID", type: "RECURRING", customerId: "customer", subscriptionId: "sub", totalCents: 30000, taxCents: 4576, currency: "USD", issuedAt: new Date(raw.finalized_at), dueDate: "2026-11-03", periodStart: "2026-11-01", periodEnd: "2026-12-01", paidAt: new Date(raw.paid_at), paymentRefs: ["bank-ref"], packCredits: 0 });
});
test("only a subscription-free ONE_OFF Purchase credits line is a pack; refunds and unsettled references excluded", () => {
  const pack = { ...raw, invoice_type: "ONE_OFF", subscription_id: null, line_items: [{ name: "Purchase credits", quantity: "100" }], transactions: [...raw.transactions, { provider_transaction_id: "refund", status: "SETTLED", payment_type: "REFUND" }, { provider_transaction_id: "pending", status: "PENDING", payment_type: "PAYMENT" }, { provider_transaction_id: null, status: "SETTLED", payment_type: "PAYMENT" }] };
  expect(toInvoice(pack)).toMatchObject({ packCredits: 100, periodStart: null, paymentRefs: ["bank-ref"] });
  expect(toInvoice({ ...pack, subscription_id: "sub" }).packCredits).toBe(0);
  expect(toInvoice({ ...pack, invoice_type: "RECURRING" }).packCredits).toBe(0);
  expect(toInvoice({ ...pack, line_items: [{ name: "Staff credits", quantity: "100" }] }).packCredits).toBe(0);
});
test("minimal invoice defaults unpaid, USD, invoice date, no payment or period", () => {
  expect(toInvoice({ id: "x", customer_id: "c", status: "FINALIZED", invoice_type: "ONE_OFF", created_at: "2026-11-01", invoice_date: "2026-11-01" })).toMatchObject({ paymentStatus: "UNPAID", currency: "USD", totalCents: 0, taxCents: 0, issuedAt: new Date("2026-11-01"), dueDate: "2026-11-01", paidAt: null, paymentRefs: [], packCredits: 0 });
});
test("protobuf strings, UTF8, varints, bools and nested messages encode exactly", () => {
  expect(encodeProto([[1, "a"], [2, 300], [3, true], [4, [[1, "é"]]]]).toString("hex")).toBe("0a016110ac02180122040a02c3a9");
});
test("gRPC-web sends framed proto and the API key", async () => {
  server.use(http.post("https://meteroid-grpc.test/Service/VoidInvoice", async ({ request }) => {
    expect(request.headers.get("x-api-key")).toBe("test-meteroid-key");
    expect(request.headers.get("content-type")).toBe("application/grpc-web+proto");
    expect(request.headers.get("x-grpc-web")).toBe("1");
    const body = Buffer.from(await request.arrayBuffer());
    expect(body[0]).toBe(0); expect(body.readUInt32BE(1)).toBe(body.length - 5);
    expect(body.subarray(5)).toEqual(encodeProto([[1, "invoice"]]));
    return new HttpResponse(null, { headers: { "grpc-status": "0" } });
  }));
  await meteroidGrpc("Service", "VoidInvoice", [[1, "invoice"]]);
});
test.each([[200, "7"], [503, "0"], [200, undefined]] as const)("gRPC rejects HTTP %s grpc %s", async (status, grpcStatus) => {
  server.use(http.post("https://meteroid-grpc.test/Service/Method", () => new HttpResponse(null, { status, headers: grpcStatus ? { "grpc-status": grpcStatus, "grpc-message": "not%20allowed" } : {} })));
  await expect(meteroidGrpc("Service", "Method", [])).rejects.toMatchObject({ name: "MeteroidError", status: status === 200 ? 400 : status });
});
test("gRPC accepts status from response trailers", async () => {
  server.use(http.post("https://meteroid-grpc.test/Service/Method", () => new HttpResponse("grpc-status: 0\r\n")));
  await meteroidGrpc("Service", "Method", []);
});
test.each([[404, ""], [200, "not a PDF"], [200, "%PDF-test"]] as const)("invoice PDF HTTP %s / %s returns null or PDF", async (status, body) => {
  server.use(http.get("https://meteroid.test/api/v1/invoices/inv-1/download", ({ request }) => {
    expect(request.headers.get("authorization")).toBe("Bearer test-meteroid-key"); return new HttpResponse(body, { status });
  }));
  expect(await invoicePdf("inv-1")).toEqual(body.startsWith("%PDF-") ? Buffer.from(body) : null);
});
test("PDF service failure is not hidden as not-ready", async () => {
  server.use(http.get("https://meteroid.test/api/v1/invoices/inv-1/download", () => new HttpResponse(null, { status: 503 })));
  await expect(invoicePdf("inv-1")).rejects.toMatchObject({ status: 503 });
});
test.each([null, 12345])("rule 10: subscription starts today, manual collection, two-day terms, optional custom monthly price %s", async (monthlyCents) => {
  server.use(
    http.get("https://meteroid.test/api/v1/plans", () => HttpResponse.json({ data: [{ id: "old", name: "Paid", status: "ARCHIVED" }, { id: "paid", name: "Paid", status: "ACTIVE" }] })),
    http.get("https://meteroid.test/api/v1/plans/paid", () => HttpResponse.json({ id: "paid", price_components: [{ id: "price", name: "Monthly" }] })),
    http.post("https://meteroid.test/api/v1/subscriptions", async ({ request }) => {
      expect(request.headers.get("idempotency-key")).toBe("paid-subscription-org-2026-11-01-2");
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({ customer_id_or_alias: "customer", plan_id: "paid", start_date: "2026-11-01", activation_condition: "ON_START", charge_automatically: false, net_terms: 2 });
      if (monthlyCents) expect(body.price_components).toEqual({ overridden_components: [{ component_id: "price", name: "Monthly", price_entry: { type: "NEW", cadence: "MONTHLY", currency: "USD", pricing: { type: "RATE", rate: "123.45" } } }] });
      else expect(body).not.toHaveProperty("price_components");
      return HttpResponse.json({ subscription: { id: "sub", status: "PENDING_ACTIVATION" } });
    }),
  );
  expect(await createPaidSubscription({ orgId: "org", customerId: "customer", today: "2026-11-01", attempt: 2, monthlyCents })).toEqual({ id: "sub", status: "PENDING_ACTIVATION" });
});
test("rules 19–20: top-up requests an invoice, never marks paid or grants credits itself", async () => {
  server.use(http.post("https://meteroid.test/api/v1/customers/customer/top-ups", async ({ request }) => {
    expect(request.headers.get("idempotency-key")).toBe("pack-org-request");
    expect(await request.json()).toEqual({ amount: 100, credit_unit: "MINS", collection: "SEND_INVOICE", unit_price: "0.21180000", expires_at: "2027-11-01T23:59:59.000Z" });
    return HttpResponse.json({ invoice_id: "pack-invoice" });
  }));
  expect(await createPackInvoice({ customerId: "customer", credits: 100, unitPrice: "0.21180000", expiresAt: new Date("2027-11-01T23:59:59Z"), key: "pack-org-request" })).toEqual({ invoiceId: "pack-invoice" });
});
