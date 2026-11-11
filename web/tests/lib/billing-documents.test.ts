import { expect, setSystemTime, test } from "bun:test";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { billingDocument, money, receiptNumber, renderInvoice, renderReceipt, SELLER } from "@/lib/billing/documents";
import type { RawInvoice } from "@/lib/billing/meteroid";

const customer = {
  name: "Example Coaching Pvt Ltd", email: "accounts@example.com", vat_number: "33AAGCF6592D1ZN",
  billing_address: { line1: "10 School Street", line2: "Floor 2, Tamil Nadu (33)", city: "Chennai", zip_code: "600001", state: "Tamil Nadu", country: "IN" },
};
const raw: RawInvoice = {
  id: "inv-001", invoice_number: "INV-001", invoice_date: "2026-11-11", due_date: "2026-11-13",
  currency: "USD", subtotal: 25424, tax_amount: 4576, total: 30000,
  tax_breakdown: [
    { name: "CGST", tax_rate: "0.0900", tax_amount: 2288, exemption_type: null, exemption_reason: null },
    { name: "SGST", tax_rate: "0.0900", tax_amount: 2288, exemption_type: null, exemption_reason: null },
  ],
  customer_details: customer,
  line_items: [{ name: "TrainerTwin Paid plan", description: "Monthly subscription", quantity: "1", unit_price: "254.24", start_date: "2026-11-11", end_date: "2026-12-11" }],
  transactions: [{ provider_transaction_id: "bank-001", status: "SETTLED", payment_type: "PAYMENT", amount: 30000, processed_at: "2026-11-12T10:30:00Z" }],
};
const paidAt = new Date("2026-11-12T10:30:00Z");
const document = (patch: RawInvoice = {}) => billingDocument({ ...raw, ...patch }, "Fallback Org");

async function pdfText(bytes: Buffer) {
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(1);
  const contents = pdf.getPage(0).node.Contents() as PDFArray;
  const draws = Array.from({ length: contents.size() }, (_, i) => Buffer.from(decodePDFRawStream(contents.lookup(i, PDFRawStream)).decode()).toString()).join("\n");
  // Helvetica's WinAnsi euro, en dash and middle dot are enough for these fixtures.
  const text = draws.match(/<([0-9A-F]+)> Tj/g)?.map((draw) => Buffer.from(draw.slice(1, draw.indexOf(">")), "hex").toString("latin1").replace(/\x80/g, "€").replace(/\x96/g, "–")).join("\n") ?? "";
  return { pdf, text };
}

test("rule 22: Tamil Nadu invoice preserves issued buyer, moves state after city, and shows both 9% taxes", () => {
  expect(document()).toMatchObject({
    number: "INV-001", issuedOn: "2026-11-11", dueOn: "2026-11-13", currency: "USD",
    buyer: { name: customer.name, lines: ["10 School Street", "Floor 2", "Chennai 600001", "Tamil Nadu (33)", "India"], email: customer.email, taxLabel: "GSTIN", taxId: customer.vat_number },
    placeOfSupply: "Tamil Nadu (33)", forWhom: customer.name, subtotalCents: 25424, totalCents: 30000,
    taxes: [{ label: "CGST 9%", cents: 2288 }, { label: "SGST 9%", cents: 2288 }], exemption: null,
  });
});

test("rule 22: a state-only Meteroid line2 is not duplicated above the city", () => {
  const doc = document({ customer_details: { ...customer, billing_address: { ...customer.billing_address, line2: "Tamil Nadu (33)" } } });
  expect(doc.buyer.lines).toEqual(["10 School Street", "Chennai 600001", "Tamil Nadu (33)", "India"]);
});

test("rule 22: Karnataka invoice uses IGST 18%, the issued GSTIN and place of supply", () => {
  const doc = document({
    customer_details: { ...customer, vat_number: "29ABCDE1234F1Z5", billing_address: { ...customer.billing_address, line2: "Suite 1, Karnataka (29)", city: "Bengaluru", zip_code: "560001", state: "Karnataka" } },
    tax_breakdown: [{ name: "IGST", tax_rate: "0.1800", tax_amount: 4576 }],
  });
  expect(doc.taxes).toEqual([{ label: "IGST 18%", cents: 4576 }]);
  expect(doc.placeOfSupply).toBe("Karnataka (29)");
  expect(doc.buyer).toMatchObject({ lines: ["10 School Street", "Suite 1", "Bengaluru 560001", "Karnataka (29)", "India"], taxLabel: "GSTIN", taxId: "29ABCDE1234F1Z5" });
});

test("rule 22: export has no tax rows, carries the LUT mention, outside-India place of supply and Tax ID", async () => {
  const exemption = "Supply meant for export under LUT (LUT-2026) without payment of IGST";
  const doc = document({
    customer_details: { name: "Euro Coaching", email: "billing@euro.example", vat_number: "DE123456789", billing_address: { line1: "10 Street", line2: "Suite 2", city: "Berlin", zip_code: "10115", state: null, country: "DE" } },
    subtotal: 30000, tax_amount: 0,
    tax_breakdown: [{ name: "Export", tax_rate: "0.0000", tax_amount: 0, exemption_type: "EXEMPT", exemption_reason: exemption }],
  });
  expect(doc).toMatchObject({ taxes: [], exemption, placeOfSupply: "Outside India (export of services)", buyer: { taxLabel: "Tax ID", taxId: "DE123456789", lines: ["10 Street", "Suite 2", "Berlin 10115", "Germany"] } });
  for (const bytes of [await renderInvoice(doc), await renderReceipt(doc, paidAt)]) {
    const { text } = await pdfText(bytes);
    expect(text).toContain("Tax ID DE123456789");
    expect(text).toContain("Outside India (export of services)");
    expect(text.replace(/\n/g, " ")).toContain(exemption);
    expect(text).not.toContain("IGST 18%");
  }
});

test("rule 22: Paid-plan detail has SAC and 11 Nov – 10 Dec 2026 (end date exclusive)", () => {
  expect(document().lines).toEqual([{ description: "TrainerTwin Paid plan: Monthly subscription", detail: "SAC 998314 · 11 Nov – 10 Dec 2026", quantity: "1", unitPrice: "US$254.24", amountCents: 25424 }]);
});

test("rule 22: Purchase credits is described as minute packs with four-decimal price and rounded cents", () => {
  const doc = document({ line_items: [{ name: "Purchase credits", description: "Meteroid credit purchase", quantity: "100", unit_price: "0.2119" }] });
  expect(doc.lines).toEqual([{ description: "Minute packs: 100 credits (1 credit = 1 minute of practice)", detail: "SAC 998314", quantity: "100", unitPrice: "US$0.2119", amountCents: 2119 }]);
});

test("rule 22: payment history includes only SETTLED non-refund transactions with references, dates and cents", () => {
  const doc = document({ transactions: [
    ...raw.transactions!,
    { provider_transaction_id: "pending", status: "PENDING", payment_type: "PAYMENT", amount: 30000, processed_at: "2026-11-12" },
    { provider_transaction_id: "failed", status: "FAILED", payment_type: "PAYMENT", amount: 30000, processed_at: "2026-11-12" },
    { provider_transaction_id: "refund", status: "SETTLED", payment_type: "REFUND", amount: 30000, processed_at: "2026-11-13" },
    { provider_transaction_id: "bank-002", status: "SETTLED", payment_type: "PAYMENT", amount: 2500, processed_at: "2026-11-14T12:00:00Z" },
  ] });
  expect(doc.payments).toEqual([
    { method: "Bank transfer", reference: "bank-001", paidOn: "2026-11-12", cents: 30000 },
    { method: "Bank transfer", reference: "bank-002", paidOn: "2026-11-14", cents: 2500 },
  ]);
});

test.each([undefined, null, ""])("rule 22: missing customer name %s falls back to org name, not today's legal details", (name) => {
  expect(document({ customer_details: { ...customer, name } })).toMatchObject({ buyer: { name: "Fallback Org" }, forWhom: "Fallback Org" });
});

test.each([
  [30000, "USD", 2, "US$300.00"], [21.19, "USD", 4, "US$0.2119"], [30000, "EUR", 2, "€300.00"],
  [2500000, "INR", 2, "INR 25,000.00"], [123456789, "INR", 2, "INR 12,34,567.89"], [0, "USD", 2, "US$0.00"],
] as const)("PDF money %s %s (%s decimals) is %s", (cents, currency, decimals, expected) => {
  expect(money(cents, currency, decimals)).toBe(expected);
});

test("rule 22: invoice is a valid app PDF with seller/buyer, line, dates, taxes and multiline payment instructions", async () => {
  const { pdf, text } = await pdfText(await renderInvoice(document(), "Bank: Example Bank\nAccount: 123456\nSWIFT: EXAMPLE"));
  expect(pdf.getTitle()).toBe("Invoice INV-001"); expect(pdf.getAuthor()).toBe(SELLER.name);
  expect(pdf.getCreator()).toBe("TrainerTwin"); expect(pdf.getProducer()).toBe("TrainerTwin");
  for (const value of ["Invoice", "INV-001", "Date of issue", "11 November 2026", "Date due", "13 November 2026", "Place of supply", SELLER.name, SELLER.line1, SELLER.gstin, SELLER.email, customer.name, customer.email, `GSTIN ${customer.vat_number}`, "Chennai 600001", "Tamil Nadu (33)", "US$300.00 due 13 November 2026", "How to pay", "Bank: Example Bank", "Account: 123456", "SWIFT: EXAMPLE", "Please quote INV-001 with your payment.", "SAC 998314 · 11 Nov – 10 Dec 2026", "Subtotal (taxable value)", "US$254.24", "CGST 9%", "SGST 9%", "US$22.88", "Amount due", "computer-generated invoice and needs no signature"]) expect(text).toContain(value);
  expect(text).not.toContain("Payment history");
});

test("rule 22: receipt is a valid app PDF with same invoice lines/totals and settled payment history", async () => {
  const { pdf, text } = await pdfText(await renderReceipt(document(), paidAt));
  expect(receiptNumber("INV-001")).toBe("RCPT-INV-001"); expect(SELLER.sac).toBe("998314");
  expect(pdf.getTitle()).toBe("Receipt RCPT-INV-001"); expect(pdf.getAuthor()).toBe(SELLER.name);
  for (const value of ["Receipt", "INV-001", "RCPT-INV-001", "Date paid", "US$300.00 paid on 12 November 2026", SELLER.name, customer.name, "SAC 998314 · 11 Nov – 10 Dec 2026", "CGST 9%", "SGST 9%", "Amount paid", "Payment history", "Bank transfer · bank-001", "12 November 2026", "US$300.00", "which is the tax invoice"]) expect(text).toContain(value);
  expect(text).not.toContain("Amount due"); expect(text).not.toContain("How to pay");
});

test.each(["invoice", "receipt"] as const)("rule 22: %s bytes are deterministic across render dates with document/payment metadata dates", async (kind) => {
  const doc = document();
  const render = () => kind === "invoice" ? renderInvoice(doc, "Bank account\nReference INV-001") : renderReceipt(doc, paidAt);
  try {
    setSystemTime(new Date("2026-11-14")); const first = await render();
    setSystemTime(new Date("2027-02-01")); const second = await render();
    expect(second.equals(first)).toBe(true);
    const { pdf } = await pdfText(first);
    const expectedDate = kind === "invoice" ? new Date("2026-11-11T00:00:00Z") : paidAt;
    expect(pdf.getCreationDate()).toEqual(expectedDate); expect(pdf.getModificationDate()).toEqual(expectedDate);
  } finally { setSystemTime(); }
});

test.each(["EUR", "INR"])("rule 22: both PDFs preserve %s amounts without unsupported currency glyphs", async (currency) => {
  const doc = document({ currency });
  for (const bytes of [await renderInvoice(doc), await renderReceipt(doc, paidAt)]) {
    const { text } = await pdfText(bytes);
    expect(text).toContain(currency === "EUR" ? "€300.00" : "INR 300.00");
    expect(text).not.toContain("US$"); expect(text).not.toContain("₹");
  }
});

test.each(["invoice", "receipt"] as const)("rule 22: %s handles non-WinAnsi buyer names and wrapped long descriptions without crashing", async (kind) => {
  const description = "Coaching practice for customer conversations and feedback across the monthly service period";
  const doc = document({ customer_details: { ...customer, name: "தமிழ் பெயர் 中文 😀" }, line_items: [{ ...raw.line_items![0], description }] });
  const bytes = kind === "invoice" ? await renderInvoice(doc, "Bank: தமிழ்\nAccount: 123") : await renderReceipt(doc, paidAt);
  const { text } = await pdfText(bytes);
  expect(text).toContain("?");
  expect(text.replace(/\n/g, " ")).toContain(`TrainerTwin Paid plan: ${description}`);
  expect(text.split("\n")).not.toContain(`TrainerTwin Paid plan: ${description}`);
});

test("rule 22: receipt without recorded transactions still confirms bank transfer at the paid date", async () => {
  const { text } = await pdfText(await renderReceipt(document({ transactions: [] }), paidAt));
  for (const value of ["Payment history", "Bank transfer", "12 November 2026", "RCPT-INV-001", "US$300.00"]) expect(text).toContain(value);
});
