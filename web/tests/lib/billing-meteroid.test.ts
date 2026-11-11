import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createPackInvoice, createPaidSubscription, decodeProto, encodeProto, getInvoiceRaw, meteroidGrpc, sellerDetails, toInvoice } from "@/lib/billing/meteroid";
import { grpcReply, seller, sellerReply } from "../setup/billing-meteroid-fixture";

const grpc = process.env.METEROID_GRPC_URL;
const server = setupServer();
beforeAll(() => { process.env.METEROID_GRPC_URL = "https://meteroid-grpc.test/"; server.listen({ onUnhandledRequest: "error" }); });
let now = Date.now();
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
beforeEach(() => { now += 10 * 60_000; clock = spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => { clock.mockRestore(); server.resetHandlers(); });
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
test("decodeProto round-trips strings, UTF8, ints, bools, repeated fields and nested encodeProto output", () => {
  const nested = encodeProto([[1, "inside"], [2, 16384]]);
  const decoded = decodeProto(encodeProto([[1, "hello"], [1, "é"], [2, 300], [3, true], [4, [[1, "inside"], [2, 16384]]], [5, ""], [6, 0], [7, false]]));
  expect(decoded).toEqual(new Map<number, (Buffer | number)[]>([
    [1, [Buffer.from("hello"), Buffer.from("é")]], [2, [300]], [3, [1]], [4, [nested]],
    [5, [Buffer.alloc(0)]], [6, [0]], [7, [0]],
  ]));
  expect(decodeProto(decoded.get(4)![0] as Buffer)).toEqual(new Map<number, (Buffer | number)[]>([[1, [Buffer.from("inside")]], [2, [16384]]]));
  expect(decodeProto(Buffer.alloc(0)).size).toBe(0);
});
test("decodeProto reads fixed64 and fixed32 alongside length-delimited and varint fields", () => {
  const fixed64 = Buffer.alloc(9); fixed64[0] = 9; fixed64.writeBigUInt64LE(4294967297n, 1);
  const fixed32 = Buffer.alloc(5); fixed32[0] = 21; fixed32.writeUInt32LE(0xfedcba98, 1);
  expect(decodeProto(Buffer.concat([fixed64, fixed32, encodeProto([[3, "after"], [4, 128]])]))).toEqual(new Map<number, (Buffer | number)[]>([
    [1, [4294967297]], [2, [0xfedcba98]], [3, [Buffer.from("after")]], [4, [128]],
  ]));
  expect(() => decodeProto(Buffer.from([11]))).toThrow("Unsupported protobuf wire type 3");
});
test("gRPC-web sends framed proto and the API key and returns only the first reply payload", async () => {
  const reply = encodeProto([[1, "reply"], [2, [[4, "nested"]]]]);
  server.use(http.post("https://meteroid-grpc.test/Service/VoidInvoice", async ({ request }) => {
    expect(request.headers.get("x-api-key")).toBe("test-meteroid-key");
    expect(request.headers.get("content-type")).toBe("application/grpc-web+proto");
    expect(request.headers.get("x-grpc-web")).toBe("1");
    const body = Buffer.from(await request.arrayBuffer());
    expect(body[0]).toBe(0); expect(body.readUInt32BE(1)).toBe(body.length - 5);
    expect(body.subarray(5)).toEqual(encodeProto([[1, "invoice"]]));
    return new HttpResponse(grpcReply(reply), { headers: { "content-type": "application/grpc-web+proto" } });
  }));
  expect(await meteroidGrpc("Service", "VoidInvoice", [[1, "invoice"]])).toEqual(reply);
});
test.each([[200, "7"], [503, "0"], [200, undefined]] as const)("gRPC rejects HTTP %s grpc %s", async (status, grpcStatus) => {
  server.use(http.post("https://meteroid-grpc.test/Service/Method", () => new HttpResponse(null, { status, headers: grpcStatus ? { "grpc-status": grpcStatus, "grpc-message": "not%20allowed" } : {} })));
  await expect(meteroidGrpc("Service", "Method", [])).rejects.toMatchObject({ name: "MeteroidError", status: status === 200 ? 400 : status });
});
test("gRPC accepts status from framed trailers and returns an empty reply for void methods", async () => {
  server.use(http.post("https://meteroid-grpc.test/Service/Method", () => new HttpResponse(grpcReply())));
  expect(await meteroidGrpc("Service", "Method", [])).toEqual(Buffer.alloc(0));
});
test("sellerDetails decodes the default invoicing entity and caches two reads for ten minutes", async () => {
  let calls = 0;
  server.use(http.post("https://meteroid-grpc.test/meteroid.api.invoicingentities.v1.InvoicingEntitiesService/GetInvoicingEntity", async ({ request }) => {
    calls++;
    expect(Buffer.from(await request.arrayBuffer())).toEqual(Buffer.alloc(5));
    return new HttpResponse(sellerReply(calls === 1 ? seller : { ...seller, name: "Changed in Meteroid" }));
  }));
  expect(await sellerDetails()).toEqual(seller);
  expect(await sellerDetails()).toEqual(seller);
  expect(calls).toBe(1);
  now += 10 * 60_000 - 1;
  expect(await sellerDetails()).toEqual(seller); expect(calls).toBe(1);
  now++;
  expect(await sellerDetails()).toEqual({ ...seller, name: "Changed in Meteroid" }); expect(calls).toBe(2);
});
test.each(["gstin", "name"] as const)("sellerDetails throws on missing %s and does not cache the invalid entity", async (field) => {
  let calls = 0;
  server.use(http.post("https://meteroid-grpc.test/meteroid.api.invoicingentities.v1.InvoicingEntitiesService/GetInvoicingEntity", () => {
    calls++; return new HttpResponse(sellerReply(calls === 1 ? { ...seller, [field]: "" } : seller));
  }));
  await expect(sellerDetails()).rejects.toThrow("no legal name or GSTIN");
  expect(await sellerDetails()).toEqual(seller); expect(calls).toBe(2);
});
test("sellerDetails throws when Meteroid returns no invoicing entity", async () => {
  server.use(http.post("https://meteroid-grpc.test/meteroid.api.invoicingentities.v1.InvoicingEntitiesService/GetInvoicingEntity", () => new HttpResponse(grpcReply())));
  await expect(sellerDetails()).rejects.toThrow("Meteroid returned no invoicing entity");
});
test("raw invoice GET preserves document fields and authenticates without downloading a PDF", async () => {
  const document = { ...raw, subtotal: 25424, customer_details: { name: "Invoice-time Ltd" }, tax_breakdown: [{ name: "IGST", tax_rate: "0.1800", tax_amount: 4576 }] };
  server.use(http.get("https://meteroid.test/api/v1/invoices/inv-1", ({ request }) => {
    expect(request.headers.get("authorization")).toBe("Bearer test-meteroid-key");
    return HttpResponse.json(document);
  }));
  expect(await getInvoiceRaw("inv-1")).toEqual(document);
});
test.each([404, 503])("raw invoice HTTP %s failure propagates instead of returning not-ready", async (status) => {
  server.use(http.get("https://meteroid.test/api/v1/invoices/inv-1", () => new HttpResponse(null, { status })));
  await expect(getInvoiceRaw("inv-1")).rejects.toMatchObject({ name: "MeteroidError", status });
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
