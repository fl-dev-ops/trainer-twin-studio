import "./flow-env";
import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { PDFDocument } from "pdf-lib";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "../lib/minutes-test-db";
import { fundOrg, grantRequests } from "../setup/meteroid";
import { outsideServices } from "./harness";
import { seller, sellerReply } from "../setup/billing-meteroid-fixture";
import { billingOverview, buyPacks, checkAllBilling, invoiceIssuedEmail, invoiceOverdue, invoicePaid, invoiceReminder, paidSubscriptionEnded, recordInvoice, requestUpgrade, saveBillingDetails, startInvoiceWorkflows, syncInvoice, syncOrgInvoices } from "@/lib/billing/billing";
import { toInvoice } from "@/lib/billing/meteroid";
import { ensurePaymentLink } from "@/lib/billing/razorpay";
import { grantMinutes, giveStartingMinutes, grantMinutesToMany, learnerBalance } from "@/lib/minutes";
import { activateSession } from "@/lib/interview-sessions";
import { POST } from "@/app/api/meteroid/webhook/route";

const originalGrpcUrl = process.env.METEROID_GRPC_URL;
const razorpayKeys = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"] as const;
const originalRazorpayKeys = razorpayKeys.map((key) => process.env[key]);
const starts: { name: string; id: string }[] = [];
let runSteps = true;
let failStart = false;
mock.module("workflow/api", () => ({ start: async (fn: Function, [id]: [string]) => {
  starts.push({ name: fn.name, id });
  if (failStart) throw new Error("workflow unavailable");
  // Durable timers are tested separately: run only the immediate production steps, with real DB and MSW.
  if (runSteps && fn.name === "invoiceIssued") { await ensurePaymentLink(id).catch(() => null); await invoiceIssuedEmail(id); }
  if (runSteps && fn.name === "invoicePaid") await invoicePaid(id);
  return { runId: `run-${id}` };
} }));
const syncs: string[] = [];
mock.module("@/lib/schedule-org-credits", () => ({ scheduleOrgSync: async (id: string) => { syncs.push(id); }, scheduleOrgUsage: async () => {} }));

const details = { legalName: "Billing Ltd", country: "IN", line1: "10 Street", city: "Chennai", postalCode: "600001", state: "33", emails: ["accounts@example.com", "finance@example.com"], phone: "+919876543210" };
type Raw = Record<string, unknown>;
type Sent = { from: string; to: string[]; subject: string; text: string; reply_to: string; attachments?: { filename: string; content: string }[] };

async function expectAppPdfs(email: Sent | undefined, filenames: string[]) {
  expect(email?.attachments?.map((a) => a.filename)).toEqual(filenames);
  for (const attachment of email!.attachments!) {
    const bytes = Buffer.from(attachment.content, "base64");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(pdf.getProducer()).toBe("TrainerTwin");
    expect(pdf.getAuthor()).toBe(seller.name);
    expect(pdf.getTitle()).toBe(`${attachment.filename.startsWith("RCPT-") ? "Receipt" : "Invoice"} ${attachment.filename.slice(0, -4)}`);
  }
}

describe.skipIf(!localMinutesDb)("billing phase 2 lifecycle (real DB, fake Meteroid/Resend)", () => {
  let f: MinutesFixture;
  const extra: MinutesFixture[] = [];
  const outside = outsideServices();
  const invoices = new Map<string, Raw>();
  const sent = new Map<string, Sent>();
  const requests: { method: string; path: string; key: string | null; body?: Raw }[] = [];
  const topups = new Map<string, string>();
  let grpcPaidRace = false;
  const billing = () => db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } });
  const row = (id: string) => db.billingInvoice.findUniqueOrThrow({ where: { id } });
  const subscription = () => `paid-${f.org.id}`;
  const customer = () => `customer_${f.org.id}`;
  const upgrade = () => `upgrade-${f.org.id}`;
  function raw(id: string, patch: Raw = {}): Raw {
    return {
      id, invoice_number: `INV-${id}`, status: "FINALIZED", payment_status: "UNPAID", invoice_type: "RECURRING", customer_id: customer(), subscription_id: subscription(),
      subtotal: 25424, total: 30000, tax_amount: 4576, currency: "USD", finalized_at: "2026-11-01T12:00:00Z", due_date: "2026-11-03", invoice_date: "2026-11-01", paid_at: null,
      customer_details: { name: details.legalName, email: details.emails[0], billing_address: { line1: details.line1, line2: "Tamil Nadu (33)", city: details.city, zip_code: details.postalCode, state: "Tamil Nadu", country: "IN" } },
      tax_breakdown: [{ name: "CGST", tax_rate: "0.0900", tax_amount: 2288 }, { name: "SGST", tax_rate: "0.0900", tax_amount: 2288 }],
      line_items: [{ name: "Paid plan", quantity: "1", unit_price: "254.24", start_date: "2026-11-01", end_date: "2026-12-01" }], transactions: [], ...patch,
    };
  }
  function add(id: string, patch: Raw = {}) { const value = raw(id, patch); invoices.set(id, value); return value; }
  function paid(id: string) { Object.assign(invoices.get(id)!, { payment_status: "PAID", paid_at: "2026-11-03T23:59:59Z", transactions: [{ provider_transaction_id: "bank-001", status: "SETTLED", payment_type: "PAYMENT", amount: invoices.get(id)!.total, processed_at: "2026-11-03T23:59:59Z" }] }); }
  async function plan(plan: "trial" | "paid", withDetails = true) {
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan, paidSubscriptionId: plan === "paid" ? subscription() : null, ...(withDetails ? { billingDetails: details } : {}) } });
  }
  // Meteroid 2.2.1 (ours) sends an event's fields flat beside `type`; `nested` sends them in `data` (newer versions).
  async function webhook(type: string, data: Raw = {}, options: { bad?: boolean; raw?: string; delta?: number; customer?: string; nested?: boolean } = {}) {
    const fields = { customer_id: options.customer ?? customer(), ...data };
    const body = options.raw ?? JSON.stringify(options.nested ? { type, data: fields } : { id: "evt_billing", type, timestamp: new Date().toISOString(), ...fields });
    const id = "msg_billing", timestamp = String(Math.floor(Date.now() / 1000) + (options.delta ?? 0));
    const key = Buffer.from(process.env.METEROID_WEBHOOK_SECRET!.replace(/^whsec_/, ""), "base64");
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    return POST(new Request("http://dash.test/api/meteroid/webhook", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": options.bad ? "v1,wrong" : `v1,${signature}` } }));
  }
  beforeEach(async () => {
    setSystemTime(new Date("2026-11-01T12:00:00Z")); process.env.METEROID_GRPC_URL = "https://meteroid-grpc.test";
    // These lifecycle tests deliberately exercise missing-key failures, never real Razorpay requests.
    for (const key of razorpayKeys) delete process.env[key];
    starts.length = requests.length = syncs.length = 0; invoices.clear(); sent.clear(); topups.clear(); runSteps = true; failStart = grpcPaidRace = false;
    outside.start(); f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 100 });
    outside.use(
      http.post("https://meteroid-grpc.test/meteroid.api.invoicingentities.v1.InvoicingEntitiesService/GetInvoicingEntity", () => new HttpResponse(sellerReply())),
      http.patch("https://meteroid.test/api/v1/customers/:id", async ({ request, params }) => { requests.push({ method: "PATCH", path: `/customers/${params.id}`, key: request.headers.get("idempotency-key"), body: await request.json() as Raw }); return HttpResponse.json({ id: params.id }); }),
      http.get("https://meteroid.test/api/v1/plans", () => HttpResponse.json({ data: [{ id: "paid-plan", name: "Paid", status: "ACTIVE" }] })),
      http.get("https://meteroid.test/api/v1/plans/paid-plan", () => HttpResponse.json({ id: "paid-plan", price_components: [{ id: "price", name: "Monthly" }] })),
      http.post("https://meteroid.test/api/v1/subscriptions", async ({ request }) => {
        requests.push({ method: "POST", path: "/subscriptions", key: request.headers.get("idempotency-key"), body: await request.json() as Raw });
        add(upgrade()); return HttpResponse.json({ id: subscription(), status: "ACTIVE" });
      }),
      http.get("https://meteroid.test/api/v1/subscriptions/:id", ({ params }) => HttpResponse.json({ id: params.id, status: "ACTIVE", plan_name: "Paid", customer_id: customer() })),
      http.post("https://meteroid.test/api/v1/subscriptions/:id/cancel", async ({ params, request }) => { requests.push({ method: "POST", path: `/subscriptions/${params.id}/cancel`, key: null, body: await request.json() as Raw }); return HttpResponse.json({ status: "CANCELLED" }); }),
      http.get("https://meteroid.test/api/v1/invoices", ({ request }) => HttpResponse.json({ data: [...invoices.values()].filter((i) => i.customer_id === new URL(request.url).searchParams.get("customer_id")) })),
      http.get("https://meteroid.test/api/v1/invoices/:id", ({ params }) => invoices.has(String(params.id)) ? HttpResponse.json(invoices.get(String(params.id))!) : HttpResponse.json({ error: "not found" }, { status: 404 })),
      http.post("https://meteroid-grpc.test/:service/VoidInvoice", async ({ request }) => {
        const frame = Buffer.from(await request.arrayBuffer());
        const id = frame.subarray(7).toString();
        requests.push({ method: "POST", path: "VoidInvoice", key: request.headers.get("x-api-key") });
        if (grpcPaidRace) { paid(id); return new HttpResponse(null, { headers: { "grpc-status": "9", "grpc-message": "already%20paid" } }); }
        Object.assign(invoices.get(id)!, { status: "VOID" });
        return new HttpResponse(null, { headers: { "grpc-status": "0" } });
      }),
      http.post("https://meteroid.test/api/v1/customers/:id/top-ups", async ({ request }) => {
        const key = request.headers.get("idempotency-key")!;
        const body = await request.json() as Raw;
        requests.push({ method: "POST", path: "/top-ups", key, body });
        if (!topups.has(key)) { const id = `pack-${f.org.id}`; topups.set(key, id); add(id, { subscription_id: null, invoice_type: "ONE_OFF", subtotal: 2118, tax_amount: 382, total: 2500, tax_breakdown: [{ name: "CGST", tax_rate: "0.0900", tax_amount: 191 }, { name: "SGST", tax_rate: "0.0900", tax_amount: 191 }], line_items: [{ name: "Purchase credits", quantity: String(body.amount), unit_price: String(body.unit_price) }] }); }
        return HttpResponse.json({ invoice_id: topups.get(key) });
      }),
      http.post("https://api.resend.com/emails", async ({ request }) => { const key = request.headers.get("idempotency-key")!; const body = await request.json() as Sent; if (!sent.has(key)) sent.set(key, body); return HttpResponse.json({ id: `email-${key}` }); }),
    );
  });
  afterEach(async () => {
    setSystemTime(); await f.clean(); for (const other of extra.splice(0)) await other.clean();
    outside.stop(); expect(outside.unexpected).toEqual([]); expect(outside.paymentLinks).toEqual([]); expect(outside.razorpayReads).toEqual([]); outside.reset(); outside.resetHandlers();
    razorpayKeys.forEach((key, index) => { if (originalRazorpayKeys[index] === undefined) delete process.env[key]; else process.env[key] = originalRazorpayKeys[index]; });
  });

  afterAll(() => {
    if (originalGrpcUrl === undefined) delete process.env.METEROID_GRPC_URL; else process.env.METEROID_GRPC_URL = originalGrpcUrl;
  });

  test("rules 1–3: billed org starts Trial, never expires or receives plan credits; rule 26 cached overview survives Meteroid down", async () => {
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: null, pausedAt: null });
    outside.use(http.all("https://meteroid.test/*", () => new HttpResponse(null, { status: 503 })));
    expect(await billingOverview(f.org.id)).toMatchObject({ billed: true, plan: "trial", monthlyCents: 30000, invoices: [] });
    expect(await billingOverview("not-billed")).toEqual({ billed: false });
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("rules 6, 8, 26: saving validates, patches first; Meteroid down changes nothing", async () => {
    await expect(requestUpgrade(f.org.id)).rejects.toMatchObject({ status: 400 });
    await expect(buyPacks(f.org.id, 1, randomUUID())).rejects.toMatchObject({ status: 400 });
    await expect(saveBillingDetails(f.org.id, { ...details, state: undefined })).rejects.toMatchObject({ status: 400, message: "state: Choose the state" });
    await expect(saveBillingDetails(f.org.id, { ...details, hacker: 1 })).rejects.toMatchObject({ status: 400 });
    expect(requests).toEqual([]);
    expect((await billing()).billingDetails).toBeNull();
    await saveBillingDetails(f.org.id, details);
    expect(await billing()).toMatchObject({ billingDetails: details });
    expect(requests[0]).toMatchObject({ method: "PATCH", body: { name: "Billing Ltd", billing_address: { line2: "Tamil Nadu (33)" } } });
    outside.use(http.patch("https://meteroid.test/api/v1/customers/:id", () => new HttpResponse(null, { status: 503 })));
    await expect(saveBillingDetails(f.org.id, { ...details, legalName: "Changed" })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("try again") });
    expect((await billing()).billingDetails).toEqual(details);
  });
  test("rules 10, 13, 21, 24: repeated upgrade/webhook creates one subscription, kind upgrade and one workflow/email", async () => {
    await saveBillingDetails(f.org.id, details);
    expect(await requestUpgrade(f.org.id)).toEqual({ subscriptionId: subscription(), created: true, payUrl: null });
    expect(await requestUpgrade(f.org.id)).toEqual({ subscriptionId: subscription(), created: false, payUrl: null });
    await webhook("invoice.finalized", { invoice_id: upgrade() }); await webhook("invoice.finalized", { invoice_id: upgrade() });
    expect(requests.filter((r) => r.path === "/subscriptions")).toHaveLength(1);
    expect(requests.find((r) => r.path === "/subscriptions")!.key).toBe(`paid-subscription-${f.org.id}-${new Date().toISOString().slice(0, 10)}-0`);
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: subscription(), pausedAt: null });
    expect(await row(upgrade())).toMatchObject({ kind: "upgrade", status: "unpaid", currency: "USD", issuedRunAt: expect.any(Date), issuedEmailAt: expect.any(Date) });
    expect(starts).toEqual([{ name: "invoiceIssued", id: upgrade() }]);
    const email = sent.get(`billing-issued-${upgrade()}`)!;
    expect(email).toMatchObject({ from: "TrainerTwin Billing <billing@trainertwin.com>", reply_to: "support@trainertwin.com", to: details.emails });
    await expectAppPdfs(email, [`INV-${upgrade()}.pdf`]);
    expect(email.text).toContain(`To pay invoice INV-${upgrade()}, reply to this email and we'll send you a payment link.`);
    expect(email.text).not.toMatch(/bank|SWIFT|IFSC|How to pay|Pay online:|Pay .* now/i);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("rules 11, 21, 22: upgrade paid activates Paid, sends receipt and invoice exactly once; paid org cannot upgrade", async () => {
    await plan("trial"); await requestUpgrade(f.org.id); paid(upgrade());
    await webhook("invoice.paid", { invoice_id: upgrade() }); await webhook("invoice.paid", { invoice_id: upgrade() });
    expect(await billing()).toMatchObject({ plan: "paid", paidSubscriptionId: subscription() });
    await expectAppPdfs(sent.get(`billing-paid-${upgrade()}`), [`RCPT-INV-${upgrade()}.pdf`, `INV-${upgrade()}.pdf`]);
    expect(sent.get(`billing-paid-${upgrade()}`)?.text).toContain("now on the Paid plan");
    expect(starts.filter((s) => s.name === "invoicePaid")).toHaveLength(1);
    await expect(requestUpgrade(f.org.id)).rejects.toMatchObject({ status: 409 });
    const invoicesForOrg = await db.billingInvoice.findMany({ where: { orgId: f.org.id } });
    // The spec's Checks after this lifecycle: paid subscription, positive linked rows and completed email marks.
    expect(invoicesForOrg.every((i) => i.totalCents > 0 && i.orgId === f.org.id && i.issuedEmailAt && (i.status !== "paid" || i.paidEmailAt))).toBe(true);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("rule 12: overdue upgrade voids by gRPC, cancels Paid sub and remains Trial, upgrade can be requested again", async () => {
    await plan("trial"); await requestUpgrade(f.org.id);
    expect(await invoiceOverdue(upgrade(), new Date("2026-11-03T23:59:59Z"))).toEqual({ action: "none", status: "unpaid" });
    expect(await invoiceOverdue(upgrade(), new Date("2026-11-04"))).toEqual({ action: "upgrade_cancelled" });
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: null, pausedAt: null });
    expect(await row(upgrade())).toMatchObject({ status: "void" });
    expect(requests.filter((r) => r.path === "VoidInvoice")).toHaveLength(1);
    expect(requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(1);
    await invoiceOverdue(upgrade(), new Date("2026-11-05"));
    expect([...sent.keys()].filter((k) => k.startsWith("billing-upgrade_cancelled"))).toHaveLength(1);
    expect(sent.get(`billing-upgrade_cancelled-${upgrade()}`)?.attachments).toBeUndefined();
    await requestUpgrade(f.org.id);
    expect(requests.filter((r) => r.path === "/subscriptions").at(-1)!.key).toEndWith("-1");
  });
  test.each([
    ["cancel", "step"], ["cancel", "daily"], ["email", "step"], ["email", "daily"],
  ] as const)("rule 12: overdue upgrade resumes after %s failure via %s, even when Meteroid shows VOID", async (failure, retry) => {
    await plan("trial"); await requestUpgrade(f.org.id);
    const now = new Date("2026-11-04");
    let cancelAttempts = 0, emailAttempts = 0, status = "ACTIVE";
    outside.use(
      http.get("https://meteroid.test/api/v1/subscriptions/:id", ({ params }) => HttpResponse.json({ id: params.id, status, plan_name: "Paid", customer_id: customer() })),
      http.post("https://meteroid.test/api/v1/subscriptions/:id/cancel", () => {
        cancelAttempts++;
        if (failure === "cancel" && cancelAttempts === 1) return HttpResponse.json({ error: "cancel unavailable" }, { status: 500 });
        status = "CANCELLED";
        return HttpResponse.json({ status });
      }),
      http.post("https://api.resend.com/emails", async ({ request }) => {
        emailAttempts++;
        if (failure === "email" && emailAttempts === 1) return HttpResponse.json({ name: "application_error", message: "email unavailable" }, { status: 500 });
        const key = request.headers.get("idempotency-key")!;
        sent.set(key, await request.json() as Sent);
        return HttpResponse.json({ id: "cancel-mail" });
      }),
    );
    await expect(invoiceOverdue(upgrade(), now)).rejects.toThrow();
    expect(invoices.get(upgrade())!.status).toBe("VOID");
    expect(await row(upgrade())).toMatchObject({ status: "void", overdueAt: expect.any(Date), overdueEmailAt: null });
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: failure === "cancel" ? subscription() : null });
    if (retry === "daily") expect(await syncOrgInvoices(f.org.id, now)).toEqual({ invoices: 1, repaired: 1 });
    else expect(await invoiceOverdue(upgrade(), now)).toEqual({ action: "upgrade_cancelled" });
    expect(status).toBe("CANCELLED");
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: null, pausedAt: null });
    expect((await row(upgrade())).overdueEmailAt).not.toBeNull();
    expect(sent.get(`billing-upgrade_cancelled-${upgrade()}`)?.subject).toBe("Your upgrade to the TrainerTwin Paid plan was cancelled");
    expect(sent.get(`billing-upgrade_cancelled-${upgrade()}`)?.attachments).toBeUndefined();
    expect(requests.filter((r) => r.path === "VoidInvoice")).toHaveLength(1);
    await invoiceOverdue(upgrade(), now); await syncOrgInvoices(f.org.id, now);
    expect(emailAttempts).toBe(failure === "email" ? 2 : 1);
  });
  test("rule 15: renewal paid during the pause is immediately unpaused and emailed as active", async () => {
    await plan("paid"); const id = `pause-race-${f.org.id}`; add(id); await syncInvoice(id);
    let reads = 0, observedPause = false;
    outside.use(http.get("https://meteroid.test/api/v1/invoices/:id", async () => {
      reads++;
      if (reads === 2) { observedPause = (await billing()).pausedAt !== null; paid(id); }
      return HttpResponse.json(invoices.get(id)!);
    }));
    expect(await invoiceOverdue(id, new Date("2026-11-04"))).toEqual({ action: "none", status: "paid" });
    expect(observedPause).toBe(true);
    expect((await billing()).pausedAt).toBeNull();
    expect(sent.get(`billing-paid-${id}`)?.text).toContain("plan is active");
    expect(sent.has(`billing-paused-${id}`)).toBe(false);
  });
  test.each(["ACTIVE", "PENDING_ACTIVATION", "PENDING_CHARGE", "CANCELLED"])("kindOf adopts only a live Paid subscription (%s)", async (status) => {
    await plan("trial"); const id = `adopt-${f.org.id}`; add(id);
    outside.use(http.get("https://meteroid.test/api/v1/subscriptions/:id", ({ params }) => HttpResponse.json({ id: params.id, status, plan_name: "Paid", customer_id: customer() })));
    await syncInvoice(id);
    const live = status !== "CANCELLED";
    expect((await row(id)).kind).toBe(live ? "upgrade" : "other");
    expect((await billing()).paidSubscriptionId).toBe(live ? subscription() : null);
    paid(id); await invoicePaid(id);
    expect((await billing()).plan).toBe(live ? "paid" : "trial");
  });
  test.each(["ACTIVE", "CANCELLED"])("rule 11: known upgrade paid after losing its subscription id adopts only %s if live", async (status) => {
    await plan("trial"); await requestUpgrade(f.org.id);
    expect((await row(upgrade())).kind).toBe("upgrade");
    await webhook("subscription.cancelled", { subscription_id: subscription() });
    outside.use(http.get("https://meteroid.test/api/v1/subscriptions/:id", ({ params }) => HttpResponse.json({ id: params.id, status, plan_name: "Paid", customer_id: customer() })));
    paid(upgrade()); await invoicePaid(upgrade());
    expect(await billing()).toMatchObject({ plan: status === "ACTIVE" ? "paid" : "trial", paidSubscriptionId: status === "ACTIVE" ? subscription() : null, pausedAt: null });
    expect(sent.get(`billing-paid-${upgrade()}`)?.text).toContain(status === "ACTIVE" ? "now on the Paid plan" : "We'll be in touch about your plan");
  });
  test("rule 10: staff cancelled pending upgrade gets a new subscription and same-day attempt key", async () => {
    await plan("trial"); await requestUpgrade(f.org.id);
    await webhook("subscription.cancelled", { subscription_id: subscription() });
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: null });
    expect((await row(upgrade())).status).toBe("unpaid");
    const next = `next-${subscription()}`;
    outside.use(http.post("https://meteroid.test/api/v1/subscriptions", async ({ request }) => {
      requests.push({ method: "POST", path: "/subscriptions", key: request.headers.get("idempotency-key"), body: await request.json() as Raw });
      add(`next-${upgrade()}`, { subscription_id: next });
      return HttpResponse.json({ id: next, status: "ACTIVE" });
    }));
    expect(await requestUpgrade(f.org.id)).toEqual({ subscriptionId: next, created: true, payUrl: null });
    expect(await requestUpgrade(f.org.id)).toEqual({ subscriptionId: next, created: false, payUrl: null });
    expect(requests.filter((r) => r.path === "/subscriptions").map((r) => r.key)).toEqual([
      `paid-subscription-${f.org.id}-2026-11-01-0`, `paid-subscription-${f.org.id}-2026-11-01-1`,
    ]);
    expect((await billing()).paidSubscriptionId).toBe(next);
  });
  test("rule 12: payment wins a last-moment void race, never cancels subscription", async () => {
    await plan("trial"); await requestUpgrade(f.org.id); grpcPaidRace = true;
    expect(await invoiceOverdue(upgrade(), new Date("2026-11-04"))).toEqual({ action: "none", status: "paid" });
    expect(requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
    expect((await billing()).paidSubscriptionId).toBe(subscription());
    expect(sent.has(`billing-upgrade_cancelled-${upgrade()}`)).toBe(false);
    await invoicePaid(upgrade()); expect((await billing()).plan).toBe("paid");
  });
  test("rules 14–17: reminder once, overdue pause preserves credits, refuses grants and packs, payment unpauses", async () => {
    await plan("paid"); const id = `renewal-${f.org.id}`; add(id); await syncInvoice(id);
    setSystemTime(new Date("2026-11-02T00:00:00Z"));
    expect(await invoiceReminder(id)).toBe(true); expect(await invoiceReminder(id)).toBe(false);
    setSystemTime();
    await invoiceOverdue(id, new Date("2026-11-04")); await invoiceOverdue(id, new Date("2026-11-04"));
    expect((await billing()).pausedAt).not.toBeNull();
    expect([...sent.keys()].filter((k) => k.startsWith("billing-paused"))).toHaveLength(1);
    await expectAppPdfs(sent.get(`billing-paused-${id}`), [`INV-${id}.pdf`]);
    await expectAppPdfs(sent.get(`billing-reminder-${id}`), [`INV-${id}.pdf`]);
    expect((await billing()).balanceMinutes).toBe(100);
    for (const call of [() => grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 5 }), () => giveStartingMinutes({ orgId: f.org.id, emails: [f.learner.email], minutes: 5 }), () => grantMinutesToMany({ orgId: f.org.id, emails: [f.learner.email], minutes: 5 })]) await expect(call()).rejects.toMatchObject({ name: "MinutesError", status: 403, message: expect.stringContaining("Settings › Billing") });
    await expect(buyPacks(f.org.id, 1, randomUUID())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("pay the overdue invoice first") });
    paid(id); await invoicePaid(id, new Date("2026-11-04"));
    expect((await billing()).pausedAt).toBeNull(); expect(sent.get(`billing-paid-${id}`)?.text).toContain("plan is active");
  });
  test.each(["2026-11-01", "2026-11-03", "2026-11-04"])("rule 14: no due-tomorrow reminder outside reminder day (%s)", async (day) => {
    await plan("paid"); const id = `reminder-${f.org.id}`; add(id); await syncInvoice(id);
    setSystemTime(new Date(day));
    expect(await invoiceReminder(id)).toBe(false);
    expect(sent.has(`billing-reminder-${id}`)).toBe(false);
  });
  test("rule 21: paused email is recorded once even after Resend's 24-hour idempotency window", async () => {
    await plan("paid"); const id = `pause-retry-${f.org.id}`; add(id); await syncInvoice(id);
    const deliveries: string[] = [];
    const accepted = new Map<string, number>();
    outside.use(http.post("https://api.resend.com/emails", ({ request }) => {
      const key = request.headers.get("idempotency-key")!;
      if (!accepted.has(key) || Date.now() - accepted.get(key)! >= 86400000) { deliveries.push(key); accepted.set(key, Date.now()); }
      return HttpResponse.json({ id: "paused-mail" });
    }));
    setSystemTime(new Date("2026-11-04")); await invoiceOverdue(id);
    setSystemTime(new Date("2026-11-06")); await invoiceOverdue(id);
    expect(deliveries).toEqual([`billing-paused-${id}`]);
  });
  test("rule 16: paused admin/team/learner starts refused with role-specific messages; running call resumes", async () => {
    await plan("paid"); await grantMinutes({ orgId: f.org.id, email: f.learner.email, minutes: 10 });
    const activate = (userId = f.learner.id, userEmail = f.learner.email, key?: string) => activateSession({ orgId: f.org.id, userId, userEmail, agentSlug: f.roleplay.slug, mode: "voice", idempotencyKey: key });
    const live = await activate(f.learner.id, f.learner.email, "live-call");
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } });
    const before = (await learnerBalance(f.org.id, f.learner.email)).grantedSeconds;
    await expect(activate()).rejects.toMatchObject({ status: 403, message: "Practice is paused for this organization right now. Please ask your trainer." });
    for (const role of ["admin", "team"]) {
      await db.member.update({ where: { id: `${f.trainer.id}-member` }, data: { role } });
      await expect(activate(f.trainer.id, f.trainer.email)).rejects.toMatchObject({ status: 403, message: expect.stringContaining("Settings › Billing") });
    }
    expect((await activate(f.learner.id, f.learner.email, "live-call"))?.id).toBe(live!.id);
    expect((await learnerBalance(f.org.id, f.learner.email)).grantedSeconds).toBe(before);
  });
  test("rule 17: paying one of two overdue renewals stays paused until both paid", async () => {
    await plan("paid"); const a = `r1-${f.org.id}`, b = `r2-${f.org.id}`;
    add(a); add(b); await syncInvoice(a); await syncInvoice(b); await invoiceOverdue(a, new Date("2026-11-04"));
    paid(a); const first = await invoicePaid(a, new Date("2026-11-04")); expect((await billing()).pausedAt).not.toBeNull();
    expect(first).toMatchObject({ outcome: "Your plan stays paused until the other overdue invoice is paid." });
    expect(sent.get(`billing-paid-${a}`)?.text).toContain("stays paused until the other overdue invoice is paid");
    paid(b); await invoicePaid(b, new Date("2026-11-04")); expect((await billing()).pausedAt).toBeNull();
    expect(sent.get(`billing-paid-${b}`)?.text).toContain("plan is active");
    const deliveries: string[] = [];
    outside.use(http.post("https://api.resend.com/emails", async ({ request }) => {
      deliveries.push(request.headers.get("idempotency-key")!);
      return HttpResponse.json({ id: "paid-retry" });
    }));
    expect(await invoicePaid(b, new Date("2026-11-05"))).toMatchObject({ outcome: expect.stringContaining("plan is active") });
    expect(deliveries).toEqual([]);
  });
  test("rule 17 / 21: paid step retried after email failure still says active after it already unpaused the org", async () => {
    await plan("paid"); const id = `paid-email-retry-${f.org.id}`; add(id); await syncInvoice(id);
    await invoiceOverdue(id, new Date("2026-11-04")); paid(id);
    outside.use(http.post("https://api.resend.com/emails", () => HttpResponse.json({ name: "application_error", message: "paid email unavailable" }, { status: 500 })));
    await expect(invoicePaid(id, new Date("2026-11-04"))).rejects.toThrow("paid email unavailable");
    expect((await billing()).pausedAt).toBeNull(); expect((await row(id)).paidEmailAt).toBeNull();
    const attempts: string[] = [];
    outside.use(http.post("https://api.resend.com/emails", async ({ request }) => {
      const key = request.headers.get("idempotency-key")!; attempts.push(key); sent.set(key, await request.json() as Sent);
      return HttpResponse.json({ id: "paid-email-retry" });
    }));
    expect(await invoicePaid(id, new Date("2026-11-04"))).toMatchObject({ outcome: expect.stringContaining("plan is active") });
    expect(sent.get(`billing-paid-${id}`)?.text).toContain("plan is active");
    expect((await row(id)).paidEmailAt).not.toBeNull();
    await invoicePaid(id, new Date("2026-11-05")); expect(attempts).toEqual([`billing-paid-${id}`]);
  });
  test("rule 15: non-current subscription renewal never pauses or sends pause email", async () => {
    await plan("paid"); const id = `old-${f.org.id}`; add(id); await syncInvoice(id);
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { paidSubscriptionId: `new-${f.org.id}` } });
    expect(await invoiceOverdue(id, new Date("2026-11-04"))).toEqual({ action: "none", status: "unpaid" });
    expect((await billing()).pausedAt).toBeNull(); expect(sent.has(`billing-paused-${id}`)).toBe(false);
  });
  test.each(["subscription.cancelled", "subscription.ended"])("rules 18, 24: %s for current Paid sub returns Trial/unpaused; unrelated subscription unchanged", async (type) => {
    await plan("paid"); await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } });
    expect(await paidSubscriptionEnded("unrelated")).toBe(false);
    expect((await webhook(type, { subscription_id: subscription() })).status).toBe(200);
    expect(await billing()).toMatchObject({ plan: "trial", pausedAt: null, paidSubscriptionId: null });
  });
  test("rules 15, 21, 23: staff invoice emailed as other; zero/draft invoices ignored; none pauses", async () => {
    await plan("paid");
    for (const [suffix, patch] of [["staff", { invoice_type: "ONE_OFF", subscription_id: null }], ["zero", { total: 0 }], ["draft", { status: "DRAFT" }]] as const) {
      const id = `${suffix}-${f.org.id}`; add(id, patch); await syncInvoice(id);
      if (suffix === "staff") { expect(await row(id)).toMatchObject({ kind: "other" }); expect((await invoiceOverdue(id, new Date("2026-11-04"))).action).toBe("none"); }
      else expect(await db.billingInvoice.findUnique({ where: { id } })).toBeNull();
    }
    expect(sent.size).toBe(1); expect((await billing()).pausedAt).toBeNull();
  });
  test("rules 19–20: Trial/paused/invalid packs refused, retried request makes one Meteroid top-up, unpaid adds no credits or pause", async () => {
    await plan("trial"); await expect(buyPacks(f.org.id, 1, randomUUID())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("available on the Paid plan") });
    await plan("paid"); await expect(buyPacks(f.org.id, 11, randomUUID())).rejects.toMatchObject({ status: 400 });
    const key = randomUUID(), grantsBefore = grantRequests.length;
    const first = await buyPacks(f.org.id, 1, key), second = await buyPacks(f.org.id, 1, key);
    expect(first).toEqual(second); expect(first.payUrl).toBeNull(); expect(topups.size).toBe(1);
    expect(requests.filter((r) => r.path === "/top-ups").map((r) => r.key)).toEqual([`pack-${f.org.id}-${key}`, `pack-${f.org.id}-${key}`]);
    expect(requests.find((r) => r.path === "/top-ups")!.body).toMatchObject({ amount: 100, collection: "SEND_INVOICE", credit_unit: "MINS" });
    expect(new Date(String(requests.find((r) => r.path === "/top-ups")!.body!.expires_at)).toISOString()).toBe("2027-11-01T23:59:59.000Z");
    expect(await row(first.invoiceId)).toMatchObject({ kind: "pack", credits: 100 });
    expect((await invoiceOverdue(first.invoiceId, new Date("2026-11-04"))).action).toBe("none");
    expect((await billing()).pausedAt).toBeNull(); expect((await billing()).balanceMinutes).toBe(100); expect(grantRequests.length).toBe(grantsBefore);
    expect(requests.some((r) => r.path === "MarkInvoiceAsPaid")).toBe(false);
  });
  test.each(["pack", "other", "paid renewal"])("rules 14, 19, 21: %s gets no reminder; paid one-off sends receipt without app granting credits", async (kind) => {
    await plan("paid"); const id = `no-reminder-${f.org.id}`;
    add(id, kind === "paid renewal" ? { payment_status: "PAID", paid_at: "2026-11-02T00:00:00Z" } : { subscription_id: null, invoice_type: "ONE_OFF", line_items: [{ name: kind === "pack" ? "Purchase credits" : "Staff invoice", quantity: "100" }] });
    await syncInvoice(id); setSystemTime(new Date("2026-11-02"));
    expect(await invoiceReminder(id)).toBe(false); expect(sent.has(`billing-reminder-${id}`)).toBe(false);
    if (kind !== "paid renewal") { paid(id); await invoicePaid(id); await invoicePaid(id); }
    await expectAppPdfs(sent.get(`billing-paid-${id}`), [`RCPT-INV-${id}.pdf`, `INV-${id}.pdf`]);
    expect((await billing()).balanceMinutes).toBe(100);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("rule 21: failed issued-email step is retryable and marks completion only after Resend accepts", async () => {
    await plan("paid"); runSteps = false; const id = `retry-email-${f.org.id}`; add(id); await syncInvoice(id);
    outside.use(http.post("https://api.resend.com/emails", () => HttpResponse.json({ name: "application_error", message: "try again" }, { status: 503 })));
    await expect(invoiceIssuedEmail(id)).rejects.toThrow("try again"); expect((await row(id)).issuedEmailAt).toBeNull();
    const keys: (string | null)[] = [];
    outside.use(http.post("https://api.resend.com/emails", ({ request }) => { keys.push(request.headers.get("idempotency-key")); return HttpResponse.json({ id: "retry-ok" }); }));
    expect(await invoiceIssuedEmail(id)).toBe(true); expect(await invoiceIssuedEmail(id)).toBe(false);
    expect(keys).toEqual([`billing-issued-${id}`]); expect((await row(id)).issuedEmailAt).not.toBeNull();
  });
  test("rule 26: upgrade/top-up Meteroid failures return 502 without local mutation", async () => {
    await plan("trial"); const before = await billing();
    outside.use(http.post("https://meteroid.test/api/v1/subscriptions", () => new HttpResponse(null, { status: 503 })));
    await expect(requestUpgrade(f.org.id)).rejects.toMatchObject({ status: 502 }); expect(await billing()).toEqual(before);
    await plan("paid"); const paidBefore = await billing();
    outside.use(http.post("https://meteroid.test/api/v1/customers/:id/top-ups", () => HttpResponse.error()));
    await expect(buyPacks(f.org.id, 1, randomUUID())).rejects.toMatchObject({ status: 502 }); expect(await billing()).toEqual(paidBefore);
  });
  test("rule 21: missing billing emails fall back to the admin", async () => {
    await plan("paid", false); const id = `fallback-${f.org.id}`; add(id, { subscription_id: null, invoice_type: "ONE_OFF" }); await syncInvoice(id);
    expect(sent.get(`billing-issued-${id}`)?.to).toEqual([f.trainer.email]);
  });
  test("rule 24: signed webhook checks JSON/signature/time, ignores unknown customer, wallet events unchanged", async () => {
    expect((await webhook("invoice.finalized", {}, { bad: true })).status).toBe(401);
    expect((await webhook("invoice.finalized", {}, { delta: -301 })).status).toBe(401);
    expect((await webhook("invoice.finalized", {}, { raw: "{" })).status).toBe(400);
    expect((await webhook("invoice.finalized", { invoice_id: "unknown" }, { customer: "not-org" })).status).toBe(200);
    // The same event nested in `data` (newer Meteroid) is read too.
    expect(await (await webhook("invoice.voided", { invoice_id: "nested-void" }, { nested: true })).json()).toMatchObject({ invoice: "nested-void", status: "void" });
    expect(starts).toEqual([]);
    for (const type of ["wallet.funded", "wallet.debited", "wallet.depleted", "wallet.recovered", "credit_grant.expired"]) expect((await webhook(type)).status).toBe(200);
    expect(syncs).toEqual(Array(5).fill(f.org.id));
    expect(await (await webhook("customer.created")).json()).toEqual({ ok: true, ignored: "customer.created" });
  });
  test("rule 24: void webhook marks unpaid copy void; stale finalized cannot revive it or remind", async () => {
    await plan("paid"); const id = `void-${f.org.id}`; add(id); await syncInvoice(id);
    await webhook("invoice.voided", { invoice_id: id });
    expect((await row(id)).status).toBe("void"); expect(await invoiceReminder(id)).toBe(false);
    expect((await recordInvoice(toInvoice(invoices.get(id)!), f.org.id))?.status).toBe("void");
    expect((await invoiceOverdue(id, new Date("2026-11-04"))).action).toBe("none");
  });
  test("rule 24: failed workflow start releases claim; concurrent retries start once", async () => {
    await plan("paid"); const id = `claim-${f.org.id}`; add(id); failStart = true; await syncInvoice(id);
    expect((await row(id)).issuedRunAt).toBeNull(); failStart = false;
    const copy = await row(id); await Promise.all([startInvoiceWorkflows(copy), startInvoiceWorkflows(copy)]);
    expect(starts).toHaveLength(2); expect((await row(id)).issuedEmailAt).not.toBeNull();
  });
  test("rule 25: daily check copies missing invoices, handles paid upgrade, pauses missed overdue renewal, isolates org failures", async () => {
    await plan("paid"); const id = `repair-${f.org.id}`; add(id);
    expect(await syncOrgInvoices(f.org.id, new Date("2026-11-04"))).toEqual({ invoices: 1, repaired: 1 });
    expect((await billing()).pausedAt).not.toBeNull(); expect((await row(id)).issuedEmailAt).not.toBeNull();
    const other = minutesFixture(); extra.push(other); await other.create(); await fundOrg({ orgId: other.org.id, minutes: 0 });
    await db.orgBilling.update({ where: { orgId: other.org.id }, data: { billingDetails: details, paidSubscriptionId: `paid-${other.org.id}` } });
    add(`paid-repair-${other.org.id}`, { customer_id: `customer_${other.org.id}`, subscription_id: `paid-${other.org.id}`, payment_status: "PAID", paid_at: "2026-11-03T12:00:00Z" });
    outside.use(http.get("https://meteroid.test/api/v1/invoices", ({ request }) => new URL(request.url).searchParams.get("customer_id") === customer() ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ data: [...invoices.values()].filter((i) => i.customer_id === new URL(request.url).searchParams.get("customer_id")) })));
    const results = await checkAllBilling(new Date("2026-11-04"));
    expect(results.find((r) => r.orgId === f.org.id)?.error).toContain("503");
    expect(results.find((r) => r.orgId === other.org.id)).toMatchObject({ invoices: 1 });
    expect((await db.orgBilling.findUniqueOrThrow({ where: { orgId: other.org.id } })).plan).toBe("paid");
  });
  test("rule 25: daily check unpauses when the only current overdue renewal was voided", async () => {
    await plan("paid"); const id = `voided-renewal-${f.org.id}`; add(id); await syncInvoice(id);
    await invoiceOverdue(id, new Date("2026-11-04"));
    Object.assign(invoices.get(id)!, { status: "VOID" });
    expect(await syncOrgInvoices(f.org.id, new Date("2026-11-04"))).toEqual({ invoices: 1, repaired: 1 });
    expect((await row(id)).status).toBe("void"); expect((await billing()).pausedAt).toBeNull();
    expect(await syncOrgInvoices(f.org.id, new Date("2026-11-04"))).toEqual({ invoices: 1, repaired: 0 });
  });
  test("rule 18 / 25: daily check catches lost cancellation webhook and returns paused Paid org to Trial", async () => {
    await plan("paid"); await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } });
    outside.use(http.get("https://meteroid.test/api/v1/subscriptions/:id", ({ params }) => HttpResponse.json({ id: params.id, status: "CANCELLED", plan_name: "Paid", customer_id: customer() })));
    const result = await syncOrgInvoices(f.org.id, new Date("2026-11-04"));
    expect(result.invoices).toBe(0); expect(result.repaired).toBeGreaterThanOrEqual(1);
    expect(await billing()).toMatchObject({ plan: "trial", paidSubscriptionId: null, pausedAt: null });
    expect(await syncOrgInvoices(f.org.id, new Date("2026-11-04"))).toEqual({ invoices: 0, repaired: 0 });
  });
  test("rule 25: one overdue failure does not stop repairing another renewal's missing paused email", async () => {
    await plan("paid"); const broken = `broken-${f.org.id}`, repair = `repair-email-${f.org.id}`;
    add(broken); add(repair); await syncInvoice(broken); await syncInvoice(repair);
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } });
    await db.billingInvoice.update({ where: { id: repair }, data: { overdueAt: new Date("2026-11-04"), overdueEmailAt: null } });
    const reads: string[] = [];
    outside.use(http.get("https://meteroid.test/api/v1/invoices/:id", ({ params }) => {
      const id = String(params.id); reads.push(id);
      return id === broken ? HttpResponse.json({ error: "invoice unavailable" }, { status: 500 }) : HttpResponse.json(invoices.get(id)!);
    }));
    expect(await syncOrgInvoices(f.org.id, new Date("2026-11-04"))).toEqual({ invoices: 2, repaired: 1 });
    expect(reads).toContain(broken); expect(reads).toContain(repair);
    expect((await row(broken)).overdueEmailAt).toBeNull();
    expect((await row(repair)).overdueEmailAt).not.toBeNull();
    expect((await billing()).pausedAt).not.toBeNull();
    await expectAppPdfs(sent.get(`billing-paused-${repair}`), [`INV-${repair}.pdf`]);
  });
  test("rules 6 / 17 / 25: old unpaid renewal cannot block payment unpause or daily unpause", async () => {
    await plan("paid"); const old = `old-overdue-${f.org.id}`, current = `current-paid-${f.org.id}`;
    add(old); await syncInvoice(old);
    const next = `current-${subscription()}`;
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { paidSubscriptionId: next, pausedAt: new Date() } });
    add(current, { subscription_id: next }); await syncInvoice(current); paid(current);
    expect(await invoicePaid(current, new Date("2026-11-04"))).toMatchObject({ outcome: expect.stringContaining("plan is active") });
    expect((await billing()).pausedAt).toBeNull(); expect((await row(old)).status).toBe("unpaid");
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } });
    expect((await syncOrgInvoices(f.org.id, new Date("2026-11-04"))).invoices).toBe(2);
    expect((await billing()).pausedAt).toBeNull(); expect(sent.has(`billing-paused-${old}`)).toBe(false);
  });
  test("rule 17: paying an old subscription renewal must not unpause an overdue current subscription", async () => {
    await plan("paid"); const old = `old-paid-${f.org.id}`, current = `current-overdue-${f.org.id}`;
    add(old); await syncInvoice(old);
    const next = `current-${subscription()}`;
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { paidSubscriptionId: next } });
    add(current, { subscription_id: next }); await syncInvoice(current);
    await invoiceOverdue(current, new Date("2026-11-04"));
    expect((await billing()).pausedAt).not.toBeNull();
    paid(old); await invoicePaid(old, new Date("2026-11-04"));
    expect((await row(current)).status).toBe("unpaid");
    expect((await billing()).pausedAt).not.toBeNull();
    expect(sent.get(`billing-paid-${old}`)?.text).toContain("stays paused until the other overdue invoice is paid");
  });
  test("rule 21: invoice emails format the actual INR invoice currency", async () => {
    await plan("paid"); const id = `inr-${f.org.id}`; add(id, { currency: "INR", total: 2500000 }); await syncInvoice(id);
    const email = sent.get(`billing-issued-${id}`)!;
    expect(email.subject).toContain("₹25,000.00"); expect(email.text).toContain("₹25,000.00"); expect(email.text).not.toContain("$25,000.00");
  });
  test("rule 25 / Checks: daily check repairs claimed issued workflow whose email was never sent", async () => {
    await plan("paid"); runSteps = false; const id = `failed-issued-${f.org.id}`; add(id, { due_date: "2099-01-03" }); await syncInvoice(id); runSteps = true;
    await syncOrgInvoices(f.org.id);
    expect(sent.has(`billing-issued-${id}`)).toBe(false); // claimed moments ago: the workflow may still be sending
    await db.billingInvoice.update({ where: { id }, data: { issuedRunAt: new Date(Date.now() - 11 * 60_000) } });
    await syncOrgInvoices(f.org.id);
    expect((await row(id)).issuedEmailAt).not.toBeNull();
    expect(sent.has(`billing-issued-${id}`)).toBe(true);
  });
  test("rule 25 / Checks: daily check repairs claimed paid workflow whose upgrade effect/email was never handled", async () => {
    await plan("trial"); await db.orgBilling.update({ where: { orgId: f.org.id }, data: { paidSubscriptionId: subscription() } });
    runSteps = false; const id = `failed-paid-${f.org.id}`; add(id, { payment_status: "PAID", paid_at: "2026-11-03T12:00:00Z" }); await syncInvoice(id); runSteps = true;
    await db.billingInvoice.update({ where: { id }, data: { paidRunAt: new Date(Date.now() - 11 * 60_000) } });
    await syncOrgInvoices(f.org.id);
    expect((await billing()).plan).toBe("paid"); expect((await row(id)).paidEmailAt).not.toBeNull();
  });
});
