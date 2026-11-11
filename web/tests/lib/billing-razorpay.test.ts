import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from "pdf-lib";
import { billingDetailsInput, meteroidCustomerPatch } from "@/lib/billing/details";
import { billingEmail } from "@/lib/email";
import { billingDocument, renderInvoice } from "@/lib/billing/documents";
import { cancelPaymentLink, createInvoicePaymentLink, fetchPayment, paymentLinkByReference, razorpayEnabled, RazorpayDisabledError, RazorpayError, settlementRecon } from "@/lib/razorpay";

const details = { legalName: "Example Ltd", country: "US", line1: "10 Street", city: "Boston", postalCode: "02110", emails: ["billing@example.com"], phone: "+19876543210" };
const names = ["RAZORPAY_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"];
const original = Object.fromEntries(names.map((key) => [key, process.env[key]]));
const server = setupServer();
beforeEach(() => { process.env.RAZORPAY_ENABLED = "true"; process.env.RAZORPAY_KEY_ID = "rzp_test_billing"; process.env.RAZORPAY_KEY_SECRET = "test-secret"; server.listen({ onUnhandledRequest: "error" }); });
afterEach(() => { server.close(); server.resetHandlers(); for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });

test.each(["+1 987-654-3210", "+1 (987) 654.3210", "+12345678", "+123456789012345"])("rule 7: phone %s is normalized and copied to Meteroid", (phone) => {
  const parsed = billingDetailsInput.parse({ ...details, phone });
  expect(parsed.phone).toBe(phone.replace(/[\s\-().]/g, ""));
  expect(meteroidCustomerPatch(parsed).phone).toBe(parsed.phone);
});
test.each([undefined, "", "19876543210", "+1234567", "+1234567890123456", "+09876543210", "+1abc2345678"])("rule 7: phone %s is refused with the field's problem", (phone) => {
  const result = billingDetailsInput.safeParse({ ...details, phone });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some((i) => i.path[0] === "phone")).toBe(true);
});

test("rule 27: invoice link body has exact amount, silent notifications, customer, notes and callback, without expiry", async () => {
  let body: unknown;
  server.use(http.post("https://api.razorpay.com/v1/payment_links", async ({ request }) => {
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("rzp_test_billing:test-secret").toString("base64")}`);
    body = await request.json(); return HttpResponse.json({ id: "plink_123", short_url: "https://rzp.io/123", amount: 30000, currency: "USD", status: "created" });
  }));
  await createInvoicePaymentLink({ amount: 30000, currency: "USD", description: "TrainerTwin invoice INV-1", referenceId: "inv-1", notes: { invoiceId: "inv-1" }, customer: { name: details.legalName, email: details.emails[0], contact: details.phone }, callbackUrl: "https://dash.test/settings?tab=billing&paid=INV-1" });
  expect(body).toEqual({ amount: 30000, currency: "USD", accept_partial: false, description: "TrainerTwin invoice INV-1", reference_id: "inv-1", notes: { invoiceId: "inv-1" }, customer: { name: details.legalName, email: details.emails[0], contact: details.phone }, notify: { email: false, sms: false }, reminder_enable: false, callback_url: "https://dash.test/settings?tab=billing&paid=INV-1", callback_method: "get" });
});
test("rule 27: reference lookup chooses the matching reference, not the first link", async () => {
  server.use(http.get("https://api.razorpay.com/v1/payment_links", ({ request }) => {
    const ref = new URL(request.url).searchParams.get("reference_id"); expect(ref).toBe("inv /&1");
    return HttpResponse.json({ payment_links: [{ id: "wrong", reference_id: "other" }, { id: "right", reference_id: ref }] });
  }));
  expect((await paymentLinkByReference("inv /&1"))?.id).toBe("right");
  server.use(http.get("https://api.razorpay.com/v1/payment_links", () => HttpResponse.json({ payment_links: [] })));
  expect(await paymentLinkByReference("missing")).toBeNull();
});
test("rules 32, 34: cancellation, payment fees and paged settlement endpoints", async () => {
  const paths: string[] = [];
  server.use(http.all("https://api.razorpay.com/v1/*", ({ request }) => { paths.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`); return HttpResponse.json({ id: "pay_1", base_amount: 2500000, fee: 88500, tax: 13500, items: [{ entity_id: "pay_1", settlement_id: "setl_1" }] }); }));
  await cancelPaymentLink("plink_1"); expect(await fetchPayment("pay_1")).toMatchObject({ base_amount: 2500000, fee: 88500, tax: 13500 });
  expect(await settlementRecon(2026, 11, 1000, 100)).toEqual([{ entity_id: "pay_1", settlement_id: "setl_1" }]);
  expect(paths).toEqual(["POST /v1/payment_links/plink_1/cancel", "GET /v1/payments/pay_1", "GET /v1/settlements/recon/combined?year=2026&month=11&skip=1000&count=100"]);
});
test("Razorpay disabled refuses calls before network; API errors retain status for reference recovery", async () => {
  process.env.RAZORPAY_ENABLED = "false"; expect(razorpayEnabled()).toBe(false);
  await expect(fetchPayment("pay_1")).rejects.toBeInstanceOf(RazorpayDisabledError);
  process.env.RAZORPAY_ENABLED = " true "; expect(razorpayEnabled()).toBe(true);
  server.use(http.get("https://api.razorpay.com/v1/payments/pay_1", () => HttpResponse.json({ error: { description: "bad payment" } }, { status: 400 })));
  await expect(fetchPayment("pay_1")).rejects.toMatchObject({ status: 400, message: expect.stringContaining("bad payment") });
  await expect(fetchPayment("pay_1")).rejects.toBeInstanceOf(RazorpayError);
});

test.each(["issued", "reminder", "paused"] as const)("rule 28: %s email includes online button/text and bank fallback", (event) => {
  const args = { event, orgName: "Example", invoiceNumber: "INV-1", amount: "$300.00", dueDate: "13 Nov 2026", description: "Paid plan", billingUrl: "https://dash.test/settings?tab=billing", paymentInstructions: "Bank <acct>", payUrl: "https://rzp.io/123?a=1&b=2" };
  const email = billingEmail(args);
  expect(email.html).toContain('href="https://rzp.io/123?a=1&amp;b=2"'); expect(email.html).toContain("Pay $300.00 now");
  expect(email.html).toContain("Or pay by bank transfer"); expect(email.html).toContain("Bank &lt;acct&gt;");
  expect(email.text).toContain("Pay online: https://rzp.io/123?a=1&b=2"); expect(email.text).toContain("Or pay by bank transfer");
  const bankOnly = billingEmail({ ...args, payUrl: null }); expect(bankOnly.html).not.toContain("Pay $300.00 now"); expect(bankOnly.text).toContain("How to pay");
});

test("rule 28: legacy details without phone still render a valid deterministic invoice, with a clickable Pay online annotation when present", async () => {
  const doc = billingDocument({ id: "inv-1", invoice_number: "INV-1", invoice_date: "2026-11-11", due_date: "2026-11-13", currency: "USD", total: 30000, subtotal: 30000, tax_amount: 0, customer_details: { name: details.legalName, email: details.emails[0], billing_address: { line1: details.line1, city: details.city, zip_code: details.postalCode, country: details.country } }, line_items: [{ name: "Paid plan", quantity: "1", unit_price: "300" }] }, "Fallback");
  const payUrl = "https://rzp.io/123";
  let first: Buffer;
  try {
    setSystemTime(new Date("2026-11-14")); first = await renderInvoice(doc, "Bank account 123", payUrl);
    setSystemTime(new Date("2027-02-01")); expect(first.equals(await renderInvoice(doc, "Bank account 123", payUrl))).toBe(true);
  } finally { setSystemTime(); }
  const pdf = await PDFDocument.load(first, { updateMetadata: false }); expect(pdf.getPageCount()).toBe(1); expect(pdf.getProducer()).toBe("TrainerTwin");
  const page = pdf.getPage(0); const annots = page.node.Annots()!; expect(annots.size()).toBe(1);
  const link = annots.lookup(0, PDFDict); expect(link.get(PDFName.of("Subtype"))?.toString()).toBe("/Link");
  expect(link.lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI"), PDFString).decodeText()).toBe(payUrl);
  const streams = page.node.Contents() as PDFArray;
  const text = Array.from({ length: streams.size() }, (_, i) => Buffer.from(decodePDFRawStream(streams.lookup(i, PDFRawStream)).decode()).toString()).join("\n").match(/<([0-9A-F]+)> Tj/g)!.map((draw) => Buffer.from(draw.slice(1, draw.indexOf(">")), "hex").toString("latin1")).join("\n");
  expect(text).toContain("Pay online"); expect(text).toContain(payUrl); expect(text).toContain("Or by bank transfer");
  expect((await PDFDocument.load(await renderInvoice(doc, "Bank account 123"))).getPage(0).node.Annots()?.size() ?? 0).toBe(0);
});
