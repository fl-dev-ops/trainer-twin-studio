import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { addressLine2, countryName, type BillingDetails } from "@/lib/billing/details";
import { formatMoney } from "@/lib/billing/pricing";

/**
 * The payment receipt (specs/billing.md rule 22). Meteroid's invoice PDF never shows that it was paid (its renderer
 * passes no payment status), so the app makes this one: who paid, for which invoice, how much, when, and the
 * references; balance due $0.00.
 */

/** Us, as on every invoice (Meteroid's invoicing entity, scripts/meteroid-billing-setup.ts). */
export const SELLER = {
  name: "Forever Learning Solutions Pvt Ltd",
  line1: "No. 52/2A1 School Street, Right side",
  line2: "Selaiyur, Rajakilpakkam, Tambaram, Tamil Nadu (33)",
  city: "Kanchipuram",
  zip: "600073",
  state: "Tamil Nadu",
  gstin: "33AAGCF6592D1ZN",
  sac: "998314",
  email: "billing@trainertwin.com",
};

export type ReceiptInput = {
  invoiceNumber: string;
  issuedAt: Date;
  paidAt: Date;
  totalCents: number;
  taxCents: number;
  currency: string;
  references: string[];
  description: string;
  customer: BillingDetails | null;
  customerName: string;
};

export const receiptNumber = (invoiceNumber: string) => `RCPT-${invoiceNumber}`;

const day = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Standard fonts are WinAnsi only: anything else (a name in another script) is replaced, never a crash. */
const WIN_ANSI = /[^\x20-\x7E\u00A0-\u00FF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;
const safe = (value: string) => value.replace(WIN_ANSI, "?");

/** "$300.00", "€300.00"; a symbol the font can't print (₹) as its code: "INR 25,000.00". */
function money(cents: number, currency: string) {
  const formatted = formatMoney(cents, currency);
  WIN_ANSI.lastIndex = 0;
  return WIN_ANSI.test(formatted)
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency, currencyDisplay: "code" }).format(cents / 100).replace(/\u00A0/g, " ")
    : formatted;
}

export async function renderReceipt(input: ReceiptInput): Promise<Buffer> {
  // The same receipt renders the same bytes (dates from the payment, not the clock): an emailed copy can be retried.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Receipt ${receiptNumber(input.invoiceNumber)}`);
  pdf.setAuthor(SELLER.name);
  pdf.setProducer("TrainerTwin");
  pdf.setCreationDate(input.paidAt);
  pdf.setModificationDate(input.paidAt);
  const page = pdf.addPage([595.28, 841.89]); // A4
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.4, 0.4, 0.4);
  const left = 56;
  let y = 780;
  const write = (target: PDFPage, value: string, x: number, at: number, font: PDFFont = regular, size = 10, color = rgb(0.1, 0.1, 0.1)) =>
    target.drawText(safe(value), { x, y: at, size, font, color });

  write(page, "Payment receipt", left, y, bold, 22);
  write(page, receiptNumber(input.invoiceNumber), 400, y + 4, bold, 11);
  y -= 22;
  write(page, `Paid on ${day(input.paidAt)}`, left, y, regular, 11, grey);

  y -= 44;
  const top = y;
  write(page, "From", left, y, bold, 10, grey);
  y -= 16;
  write(page, SELLER.name, left, y, bold);
  for (const line of [SELLER.line1, SELLER.line2, `${SELLER.zip} ${SELLER.city}`, "India"]) write(page, line, left, (y -= 14));
  write(page, `GSTIN ${SELLER.gstin}`, left, (y -= 14));

  let ry = top;
  const right = 320;
  const customer = input.customer;
  write(page, "Received from", right, ry, bold, 10, grey);
  write(page, customer?.legalName ?? input.customerName, right, (ry -= 16), bold);
  if (customer) {
    const cityLine = [customer.postalCode, customer.city].filter(Boolean).join(" ");
    for (const line of [customer.line1, addressLine2(customer), cityLine, countryName(customer.country)]) if (line) write(page, line, right, (ry -= 14));
    if (customer.taxId) write(page, `${customer.country === "IN" ? "GSTIN" : "Tax ID"} ${customer.taxId}`, right, (ry -= 14));
  }

  y = Math.min(y, ry) - 44;
  const rows: [string, string][] = [
    ["For invoice", `${input.invoiceNumber} of ${day(input.issuedAt)}`],
    ["Description", input.description],
    ["Invoice total (tax included)", money(input.totalCents, input.currency)],
    ["Of which tax", money(input.taxCents, input.currency)],
    ["Amount received", money(input.totalCents, input.currency)],
    ["Payment reference", input.references.join(", ") || "-"],
    ["Balance due", money(0, input.currency)],
  ];
  page.drawLine({ start: { x: left, y: y + 14 }, end: { x: 539, y: y + 14 }, thickness: 0.5, color: grey });
  for (const [label, value] of rows) {
    write(page, label, left, y, label === "Amount received" ? bold : regular, 11, label === "Amount received" ? rgb(0.1, 0.1, 0.1) : grey);
    write(page, value, 260, y, label === "Amount received" || label === "Balance due" ? bold : regular, 11);
    y -= 22;
  }
  page.drawLine({ start: { x: left, y: y + 8 }, end: { x: 539, y: y + 8 }, thickness: 0.5, color: grey });

  y -= 24;
  write(page, `SAC ${SELLER.sac}. This receipt confirms payment of the invoice above, which remains the tax invoice.`, left, y, regular, 9, grey);
  write(page, `Questions: ${SELLER.email}`, left, (y -= 14), regular, 9, grey);
  return Buffer.from(await pdf.save());
}
