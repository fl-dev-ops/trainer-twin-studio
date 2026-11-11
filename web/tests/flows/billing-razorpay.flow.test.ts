import "./flow-env";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";
import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import { outsideServices, razorpayWebhook } from "./harness";
import { sellerReply } from "../setup/billing-meteroid-fixture";
import { billingOverview, buyPacks, invoiceIssuedEmail, invoiceOverdue, invoicePaid, invoiceVoided, requestUpgrade, saveBillingDetails, syncInvoice, syncOrgInvoices } from "@/lib/billing/billing";
import { closePaymentLink, ensurePaymentLink } from "@/lib/billing/razorpay";
import { billingRouter } from "@/lib/billing/trpc";
import { createPaymentLinkPurchase, linkInvoicePurchase } from "@/lib/credit-purchases";
import { POST } from "@/app/api/razorpay/webhook/route";

const starts: { name: string; id: string }[] = [];
let executeSteps = true;
mock.module("workflow/api", () => ({ start: async (fn: Function, [id]: [string]) => {
  starts.push({ name: fn.name, id });
  if (executeSteps && fn.name === "invoiceIssued") { await ensurePaymentLink(id).catch(() => null); await invoiceIssuedEmail(id); }
  if (executeSteps && fn.name === "invoicePaid") await invoicePaid(id);
  return { runId: `run-${id}` };
} }));
mock.module("@/lib/schedule-org-credits", () => ({ scheduleOrgSync: async () => {}, scheduleOrgUsage: async () => {} }));
const details = { legalName: "Billing Ltd", country: "US", line1: "10 Street", city: "Boston", postalCode: "02110", emails: ["accounts@example.com", "finance@example.com"], phone: "+19876543210" };
type Raw = Record<string, any>;
// The production gRPC-web request has a five-byte frame prefix and length-delimited protobuf fields.
function grpcFields(frame: Buffer) {
  let at = 5; const fields: Record<number, string> = {};
  const integer = () => { let n = 0, shift = 0, b; do { b = frame[at++]; n |= (b & 127) << shift; shift += 7; } while (b & 128); return n; };
  while (at < frame.length) { const tag = integer(); const length = integer(); fields[tag >> 3] = frame.subarray(at, at + length).toString(); at += length; }
  return fields;
}

describe.skipIf(!localMinutesDb)("billing Razorpay phase 3 (real DB; MSW Meteroid/Razorpay/Resend)", () => {
  let f: MinutesFixture;
  const outside = outsideServices();
  const invoices = new Map<string, Raw>(); const links = new Map<string, Raw>();
  const creates: Raw[] = [], marks: Record<number, string>[] = [], cancels: string[] = [], lookups: string[] = [], patches: Raw[] = [];
  const envNames = ["RAZORPAY_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "METEROID_GRPC_URL"];
  const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  let lag = false, failMark = false;
  const id = () => `invoice-${f.org.id}`;
  const sub = () => `paid-${f.org.id}`;
  const row = (invoiceId = id()) => db.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const billing = () => db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } });
  const caller = (orgId = f.org.id, role = "admin") => billingRouter.createCaller({ user: { ...f.trainer, orgId, orgSlug: f.org.slug, role } });
  function add(invoiceId = id(), patch: Raw = {}) {
    const value = { id: invoiceId, invoice_number: `INV-${invoiceId}`, status: "FINALIZED", payment_status: "UNPAID", customer_id: `customer_${f.org.id}`, subscription_id: null, currency: "USD", total: 30000, subtotal: 30000, tax_amount: 0, finalized_at: "2026-11-11T12:00:00Z", invoice_date: "2026-11-11", due_date: "2099-11-13", transactions: [], customer_details: { name: details.legalName, email: details.emails[0], billing_address: { line1: details.line1, city: details.city, zip_code: details.postalCode, country: "US" } }, line_items: [{ name: "Paid plan", quantity: "1", unit_price: "300" }], ...patch };
    invoices.set(invoiceId, value); return value;
  }
  async function prepare(patch: Raw = {}) { add(id(), patch); await syncInvoice(id(), f.org.id); return row(); }
  function paid(invoiceId = id(), reference = "bank-001") { Object.assign(invoices.get(invoiceId)!, { payment_status: "PAID", paid_at: "2026-11-12T10:00:00Z", transactions: [{ provider_transaction_id: reference, status: "SETTLED", payment_type: "PAYMENT", amount: invoices.get(invoiceId)!.total, processed_at: "2026-11-12T10:00:00Z" }] }); }
  const pay = async (paymentId = `pay_${f.org.id}`, patch: Raw = {}) => razorpayWebhook("payment_link.paid", { payment_link: { entity: { id: (await row()).paymentLinkId, notes: { invoiceId: id() } } }, payment: { entity: { id: paymentId, amount: 30000, currency: "USD", ...patch } } });
  function linkPaid(linkId: string, paymentId = `pay_${f.org.id}`) { Object.assign(links.get(linkId)!, { status: "paid", amount_paid: 30000, payments: [{ payment_id: paymentId, amount: 30000, status: "captured" }] }); }
  beforeEach(async () => {
    process.env.RAZORPAY_ENABLED = "true"; process.env.RAZORPAY_KEY_ID = "rzp_test_billing"; process.env.RAZORPAY_KEY_SECRET = "test-secret"; process.env.RAZORPAY_WEBHOOK_SECRET = "billing-webhook-secret"; process.env.METEROID_GRPC_URL = "https://meteroid-grpc.test";
    starts.length = creates.length = marks.length = cancels.length = lookups.length = patches.length = 0; invoices.clear(); links.clear(); executeSteps = true; lag = failMark = false;
    outside.start(); f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 0 });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: details } });
    outside.use(
      http.post("https://meteroid-grpc.test/meteroid.api.invoicingentities.v1.InvoicingEntitiesService/GetInvoicingEntity", () => new HttpResponse(sellerReply())),
      http.patch("https://meteroid.test/api/v1/customers/:id", async ({ request }) => { patches.push(await request.json() as Raw); return HttpResponse.json({}); }),
      http.get("https://meteroid.test/api/v1/plans", () => HttpResponse.json({ data: [{ id: "paid-plan", name: "Paid", status: "ACTIVE" }] })),
      http.get("https://meteroid.test/api/v1/plans/paid-plan", () => HttpResponse.json({ id: "paid-plan", price_components: [{ id: "price", name: "Monthly" }] })),
      http.post("https://meteroid.test/api/v1/subscriptions", () => { add(id(), { subscription_id: sub() }); return HttpResponse.json({ id: sub(), status: "ACTIVE" }); }),
      http.get("https://meteroid.test/api/v1/subscriptions/:id", ({ params }) => HttpResponse.json({ id: params.id, status: "ACTIVE", plan_name: "Paid", customer_id: `customer_${f.org.id}` })),
      http.post("https://meteroid.test/api/v1/subscriptions/:id/cancel", () => HttpResponse.json({ status: "CANCELLED" })),
      http.post("https://meteroid.test/api/v1/customers/:id/top-ups", () => { add(id(), { invoice_type: "ONE_OFF", total: 2500, subtotal: 2500, line_items: [{ name: "Purchase credits", quantity: "100", unit_price: "0.25" }] }); return HttpResponse.json({ invoice_id: id() }); }),
      http.get("https://meteroid.test/api/v1/invoices", () => HttpResponse.json({ data: [...invoices.values()] })),
      http.get("https://meteroid.test/api/v1/invoices/:id", ({ params }) => HttpResponse.json(invoices.get(String(params.id)) ?? {})),
      http.post("https://meteroid-grpc.test/:service/MarkInvoiceAsPaid", async ({ request }) => {
        const fields = grpcFields(Buffer.from(await request.arrayBuffer())); marks.push(fields);
        if (failMark) return new HttpResponse(null, { status: 503 });
        if (!lag) paid(fields[1], fields[4]);
        return new HttpResponse(null, { headers: { "grpc-status": "0" } });
      }),
      http.post("https://meteroid-grpc.test/:service/VoidInvoice", async ({ request }) => { invoices.get(grpcFields(Buffer.from(await request.arrayBuffer()))[1])!.status = "VOID"; return new HttpResponse(null, { headers: { "grpc-status": "0" } }); }),
      http.post("https://api.razorpay.com/v1/payment_links", async ({ request }) => {
        const body = await request.json() as Raw; creates.push(body);
        if ([...links.values()].some((link) => link.reference_id === body.reference_id)) return HttpResponse.json({ error: { description: "reference already exists" } }, { status: 400 });
        const link = { ...body, id: `plink_${randomUUID().replaceAll("-", "")}`, short_url: `https://rzp.io/${body.reference_id}`, status: "created", amount_paid: 0, payments: [] }; links.set(link.id, link); return HttpResponse.json(link);
      }),
      http.get("https://api.razorpay.com/v1/payment_links", ({ request }) => { const ref = new URL(request.url).searchParams.get("reference_id")!; lookups.push(ref); return HttpResponse.json({ payment_links: [...links.values()].filter((link) => link.reference_id === ref) }); }),
      http.get("https://api.razorpay.com/v1/payment_links/:id", ({ params }) => HttpResponse.json(links.get(String(params.id)) ?? {})),
      http.post("https://api.razorpay.com/v1/payment_links/:id/cancel", ({ params }) => { cancels.push(String(params.id)); return HttpResponse.json({ id: params.id, status: "cancelled" }); }),
      http.get("https://api.razorpay.com/v1/payments/:id", ({ params }) => HttpResponse.json({ id: params.id, amount: 30000, currency: "USD", status: "captured", base_amount: 2500000, fee: 88500, tax: 13500, method: "card", international: true, created_at: Date.parse("2026-11-12T10:00:00Z") / 1000 })),
    );
  });
  afterEach(async () => {
    await f.clean(); outside.stop(); expect(outside.unexpected).toEqual([]); outside.reset(); outside.resetHandlers();
    for (const [name, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });

  test("rule 27: one link per invoice; a lost DB save recovers the existing Razorpay reference after 400", async () => {
    const first = await prepare(); const url = first.paymentLinkUrl;
    expect(await ensurePaymentLink(id())).toBe(url); expect(creates).toHaveLength(1);
    await db.billingInvoice.update({ where: { id: id() }, data: { paymentLinkId: null, paymentLinkUrl: null } });
    expect(await ensurePaymentLink(id())).toBe(url); expect(creates).toHaveLength(2); expect(links.size).toBe(1); expect(lookups).toEqual([id()]);
    expect((await row()).paymentLinkId).toBe(first.paymentLinkId);
    expect(creates[0]).toMatchObject({ amount: 30000, currency: "USD", accept_partial: false, notify: { email: false, sms: false }, reminder_enable: false, callback_method: "get", reference_id: id(), customer: { name: details.legalName, email: details.emails[0], contact: details.phone }, notes: { invoiceId: id(), orgId: f.org.id } });
    const callback = new URL(creates[0].callback_url); expect(callback.pathname).toBe("/settings"); expect(callback.searchParams.get("tab")).toBe("billing"); expect(callback.searchParams.get("paid")).toBe(first.number); expect(creates[0].expire_by).toBeUndefined();
  });
  test.each(["off", "no phone", "paid", "void", "$0"])("rule 27: no payment link for %s", async (reason) => {
    executeSteps = false;
    if (reason === "off") process.env.RAZORPAY_ENABLED = "false";
    if (reason === "no phone") { const { phone, ...legacy } = details; await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: legacy } }); }
    await prepare();
    if (reason === "paid" || reason === "void") await db.billingInvoice.update({ where: { id: id() }, data: { status: reason } });
    // A zero-total invoice is never stored in the first place (rule 23).
    if (reason === "$0") { add(`${id()}-zero`, { total: 0 }); expect(await syncInvoice(`${id()}-zero`, f.org.id)).toBeNull(); await db.billingInvoice.delete({ where: { id: id() } }); }
    if (reason !== "$0") expect(await ensurePaymentLink(id())).toBeNull();
    expect(creates).toHaveLength(0);
    if (reason === "no phone") expect(await billingOverview(f.org.id)).toMatchObject({ billed: true, invoices: [expect.objectContaining({ payUrl: null })] });
  });
  test("rules 7, 28: save normalized phone to Meteroid, upgrade and retry return same payUrl, overview and issued email include it", async () => {
    await saveBillingDetails(f.org.id, { ...details, phone: "+1 987-654-3210" }); expect(patches[0].phone).toBe(details.phone);
    const upgraded = await requestUpgrade(f.org.id); expect(upgraded).toMatchObject({ created: true, payUrl: `https://rzp.io/${id()}` });
    expect(await requestUpgrade(f.org.id)).toMatchObject({ created: false, payUrl: upgraded.payUrl }); expect(creates).toHaveLength(1);
    expect(await billingOverview(f.org.id)).toMatchObject({ upgradeInvoice: { payUrl: upgraded.payUrl }, invoices: [expect.objectContaining({ payUrl: upgraded.payUrl })] });
    expect(outside.emails.find((email) => email.idempotencyKey === `billing-issued-${id()}`)?.text).toContain(`Pay online: ${upgraded.payUrl}`);
  });
  test("rule 28: buyPacks returns payUrl and grants no phase-1 credits", async () => {
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: sub() } });
    expect(await buyPacks(f.org.id, 1, randomUUID())).toMatchObject({ invoiceId: id(), totalCents: 2500, payUrl: `https://rzp.io/${id()}` }); expect(await availableOrgSeconds(f.org.id)).toBe(0);
  });
  test("rules 20, 29, 34: webhook marks with payment id once, records applied fees and starts claimed paid workflow", async () => {
    await requestUpgrade(f.org.id); const paymentId = `pay_${f.org.id}`;
    expect(await pay(paymentId)).toMatchObject({ status: 200, body: { result: { status: "applied", invoiceId: id() } } });
    expect(marks).toEqual([{ 1: id(), 2: "300.00", 4: paymentId }]);
    expect(await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({ invoiceId: id(), orgId: f.org.id, status: "applied", amount: 30000, currency: "USD", amountInr: 2500000, feeInr: 88500, taxInr: 13500, method: "card", international: true });
    expect(await row()).toMatchObject({ razorpayPaymentId: paymentId, status: "paid", paidRunAt: expect.any(Date), paidEmailAt: expect.any(Date) });
    expect((await billing()).plan).toBe("paid"); expect(starts.filter((s) => s.name === "invoicePaid")).toHaveLength(1); expect(cancels).toEqual([]);
    await pay(paymentId); expect(marks).toHaveLength(1); expect(await db.billingPayment.count({ where: { invoiceId: id() } })).toBe(1);
  });
  test("rule 29: THREE concurrent deliveries and later retry mark once even while Meteroid still reads UNPAID", async () => {
    await prepare(); lag = true; const results = await Promise.all([pay(), pay(), pay()]);
    for (const result of results) expect(result).toMatchObject({ status: 200, body: { result: { status: "applied" } } });
    expect(invoices.get(id())!.payment_status).toBe("UNPAID"); await pay(); expect(marks).toHaveLength(1);
    expect(await db.billingPayment.count({ where: { invoiceId: id(), status: "applied" } })).toBe(1); expect((await row()).paidRunAt).not.toBeNull(); expect(starts.filter((s) => s.name === "invoicePaid")).toHaveLength(1);
  });
  test.each(["PAID", "UNPAID"])("rule 29: mark succeeded but DB save lost and Meteroid reads %s: transaction reference recovers without marking", async (status) => {
    await prepare(); paid(id(), `pay_${f.org.id}`); invoices.get(id())!.payment_status = status;
    expect((await pay()).body).toMatchObject({ result: { status: "applied" } }); expect(marks).toEqual([]);
    expect(await row()).toMatchObject({ status: status === "PAID" ? "paid" : "unpaid", razorpayPaymentId: `pay_${f.org.id}`, paidRunAt: expect.any(Date) }); expect(await db.billingPayment.count({ where: { invoiceId: id(), status: "applied" } })).toBe(1);
  });
  test.each(["amount", "currency", "link"])("rule 30: wrong %s is 200 ignored, logged, and changes nothing", async (wrong) => {
    await prepare(); const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = await row(); let response;
      if (wrong === "link") response = await razorpayWebhook("payment_link.paid", { payment_link: { entity: { id: "plink_unknown", notes: { invoiceId: id() } } }, payment: { entity: { id: "pay_unknown", amount: 30000, currency: "USD" } } });
      else response = await pay(undefined, wrong === "amount" ? { amount: 29999 } : { currency: "INR" });
      expect(response).toMatchObject({ status: 200, body: { result: { status: "ignored" } } }); expect(await row()).toEqual(before); expect(log).toHaveBeenCalled(); expect(marks).toEqual([]); expect(await db.billingPayment.count({ where: { invoiceId: id() } })).toBe(0);
    } finally { log.mockRestore(); }
  });
  test.each(["another Razorpay payment", "bank transfer", "void"])("rule 31: payment after %s is recorded duplicate and logged, without another mark", async (first) => {
    await prepare(); if (first === "another Razorpay payment") await pay(); else if (first === "bank transfer") paid(); else invoices.get(id())!.status = "VOID";
    const before = marks.length; const second = `pay_second_${f.org.id}`; const log = spyOn(console, "error").mockImplementation(() => {});
    try { expect((await pay(second)).body).toMatchObject({ result: { status: "duplicate" } }); expect(marks).toHaveLength(before); expect(await db.billingPayment.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ status: "duplicate" }); expect(log.mock.calls.some((args) => String(args[0]).includes("DUPLICATE"))).toBe(true); } finally { log.mockRestore(); }
  });
  test("rule 29: Meteroid mark unavailable propagates for framework 5xx; transaction rolls back, no payment saved; retry succeeds", async () => {
    await prepare(); failMark = true; await expect(pay()).rejects.toThrow();
    expect((await row()).razorpayPaymentId).toBeNull(); expect((await row()).paidRunAt).toBeNull(); expect(await db.billingPayment.count({ where: { invoiceId: id() } })).toBe(0);
    failMark = false; expect((await pay()).status).toBe(200); expect((await row()).status).toBe("paid");
  });
  test("bad signature is 401; disabled webhook is 404 and makes no links", async () => {
    const request = () => new Request("http://dash.test/api/razorpay/webhook", { method: "POST", body: "{}", headers: { "x-razorpay-signature": "0".repeat(64) } });
    expect((await POST(request())).status).toBe(401); process.env.RAZORPAY_ENABLED = "false"; expect((await POST(request())).status).toBe(404); await prepare(); expect(creates).toEqual([]); expect(marks).toEqual([]);
  });
  test.each(["void", "overdue upgrade", "bank transfer"])("rule 32: cancels link on %s", async (reason) => {
    if (reason === "overdue upgrade") { await requestUpgrade(f.org.id); invoices.get(id())!.due_date = "2020-01-01"; await invoiceOverdue(id()); }
    else {
      await prepare();
      if (reason === "void") {
        const { POST: meteroidWebhook } = await import("@/app/api/meteroid/webhook/route");
        const body = JSON.stringify({ type: "invoice.voided", customer_id: `customer_${f.org.id}`, invoice_id: id() });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const key = Buffer.from(process.env.METEROID_WEBHOOK_SECRET!.replace(/^whsec_/, ""), "base64");
        const signature = createHmac("sha256", key).update(`msg_void.${timestamp}.${body}`).digest("base64");
        expect((await meteroidWebhook(new Request("http://dash.test/api/meteroid/webhook", { method: "POST", body, headers: { "webhook-id": "msg_void", "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` } }))).status).toBe(200);
        expect((await row()).status).toBe("void");
      } else { paid(); await invoicePaid(id()); }
    }
    expect(cancels).toEqual([(await row()).paymentLinkId]);
  });
  test("rule 32: close is best effort when Razorpay refuses an already paid/cancelled link", async () => {
    await prepare(); outside.use(http.post("https://api.razorpay.com/v1/payment_links/:id/cancel", () => HttpResponse.json({ error: { description: "already paid" } }, { status: 400 })));
    await closePaymentLink(await row()); expect((await row()).status).toBe("unpaid");
  });
  test("rule 33: daily check applies paid link after lost webhook", async () => {
    const invoice = await prepare(); linkPaid(invoice.paymentLinkId!);
    expect(await syncOrgInvoices(f.org.id)).toMatchObject({ repaired: 1 }); expect(marks).toHaveLength(1); expect((await row()).status).toBe("paid");
  });
  test("rule 33: daily check makes missing link when a legacy org adds phone later", async () => {
    const { phone, ...legacy } = details; await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: legacy } }); await prepare(); expect(creates).toEqual([]);
    await saveBillingDetails(f.org.id, details); expect(await syncOrgInvoices(f.org.id)).toMatchObject({ repaired: 1 }); expect((await row()).paymentLinkUrl).not.toBeNull(); expect(creates).toHaveLength(1);
  });
  test("rule 28: confirmPayment rejects another org/learner, trusts Razorpay and returns paid status on retry", async () => {
    const invoice = await prepare(); const paymentLinkId = invoice.paymentLinkId!;
    await expect(caller("another-org").confirmPayment({ paymentLinkId })).rejects.toMatchObject({ code: "NOT_FOUND" }); await expect(caller(f.org.id, "user").confirmPayment({ paymentLinkId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await caller().confirmPayment({ paymentLinkId })).toEqual({ status: "pending" }); linkPaid(paymentLinkId);
    expect(await caller().confirmPayment({ paymentLinkId })).toEqual({ status: "applied" }); expect(await caller().confirmPayment({ paymentLinkId })).toEqual({ status: "paid" }); expect(marks).toHaveLength(1);
  });
  test("rule 28: confirmPayment returns pending on Razorpay error", async () => {
    const invoice = await prepare(); outside.use(http.get("https://api.razorpay.com/v1/payment_links/:id", () => new HttpResponse(null, { status: 503 })));
    expect(await caller().confirmPayment({ paymentLinkId: invoice.paymentLinkId! })).toEqual({ status: "pending" }); expect(marks).toEqual([]); expect((await row()).razorpayPaymentId).toBeNull();
  });
  test("rule 35: phase-1 link/invoice payments and refunds still use credit purchases, not billing invoices", async () => {
    const purchase = await createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 800, currency: "INR" });
    const payload = { payment_link: { entity: { id: purchase.razorpayId, notes: { purchaseId: purchase.id } } }, payment: { entity: { id: `pay_credit_${f.org.id}`, amount: 80000, currency: "INR" } } };
    expect((await razorpayWebhook("payment_link.paid", payload)).body).toMatchObject({ result: { duplicate: false } });
    const invoiceId = `inv_credit_${f.org.id}`; outside.invoices.set(invoiceId, { id: invoiceId, status: "issued", amount: 80000, currency: "INR", amount_paid: 0 }); await linkInvoicePurchase({ org: f.org, invoiceId, credits: 100 });
    expect((await razorpayWebhook("invoice.paid", { invoice: { entity: { id: invoiceId } }, payment: { entity: { id: `pay_invoice_credit_${f.org.id}`, amount: 80000, currency: "INR" } } })).body).toMatchObject({ result: { duplicate: false } });
    expect((await razorpayWebhook("refund.processed", { refund: { entity: { id: `rfnd_${f.org.id}`, payment_id: `pay_credit_${f.org.id}`, amount: 80000, currency: "INR" } } })).status).toBe(200);
    expect(await availableOrgSeconds(f.org.id)).toBe(200 * 60); expect(marks).toEqual([]); expect(await db.billingPayment.count({ where: { orgId: f.org.id } })).toBe(0);
  });
});
