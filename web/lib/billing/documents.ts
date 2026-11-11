import { PDFDocument, PDFString, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { countryName, EXPORT_DECLARATION, INDIAN_STATES } from "@/lib/billing/details";
import type { RawInvoice, Seller } from "@/lib/billing/meteroid";

/**
 * The invoice and receipt PDFs (specs/billing.md rules 21–22), in one layout (Stripe's: title and numbers top left,
 * logo top right, seller and buyer side by side, the amount, the lines, the totals). Drawn by the app from Meteroid's
 * invoice (its numbers, lines, tax and the customer as it was when issued): Meteroid's own PDF can't be restyled and
 * never shows a payment. The invoice is the tax invoice: GSTINs, place of supply, SAC, CGST/SGST or IGST, or the
 * export mention.
 */

/** What we sell, for GST: online education and training services (one SAC for everything). */
export const SAC = "998314";

export const receiptNumber = (invoiceNumber: string) => `RCPT-${invoiceNumber}`;

export type BillingDocument = {
  /** Us: Meteroid's invoicing entity (lib/billing/meteroid.ts sellerDetails). */
  seller: Seller;
  number: string;
  issuedOn: string;
  dueOn: string;
  currency: string;
  /** Who it's for, as it read in the invoice (the org's name when Meteroid has no legal name). */
  buyer: { name: string; lines: string[]; email: string | null; taxLabel: string; taxId: string | null };
  placeOfSupply: string;
  /** What the invoice is for, under the amount ("Invoice for Olga Coaching"). */
  forWhom: string;
  lines: { description: string; detail: string; quantity: string; unitPrice: string; amountCents: number }[];
  subtotalCents: number;
  taxes: { label: string; cents: number }[];
  totalCents: number;
  /** The tax lines of an exempt invoice: for an export, the LUT declaration and its ARN (lib/billing/details.ts). */
  exemption: string[] | null;
  payments: { method: string; reference: string; paidOn: string; cents: number }[];
};

const DAY_MS = 86_400_000;
const longDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const shortDay = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "1 Aug – 31 Aug 2026" from Meteroid's period (its end is the next period's first day). */
function period(start?: string, end?: string) {
  if (!start || !end || start === end) return null;
  const last = new Date(new Date(`${end}T00:00:00Z`).getTime() - DAY_MS);
  return `${shortDay(new Date(`${start}T00:00:00Z`))} – ${shortDay(last)} ${last.getUTCFullYear()}`;
}

/** Meteroid names a credit purchase "Purchase credits"; on our invoice it's a minute pack. */
function describe(name: string, description: string | null | undefined, quantity: number) {
  if (name === "Purchase credits") return `Minute packs: ${quantity} credits (1 credit = 1 minute of practice)`;
  return description ? `${name}: ${description}` : name;
}

/** "Card", "UPI", "Netbanking" from Razorpay's method ("card", "upi", "netbanking"). */
const METHOD: Record<string, string> = { card: "Card", upi: "UPI", netbanking: "Netbanking", wallet: "Wallet", emi: "EMI", bank_transfer: "Bank transfer" };

/**
 * The invoice as the PDFs show it, from Meteroid's invoice (GET /invoices/{id}). `methods`: how each Razorpay payment
 * was made (payment id → Razorpay's method); anything else was a bank transfer marked by staff.
 */
export function billingDocument(raw: RawInvoice, orgName: string, seller: Seller, methods: Record<string, string | null> = {}): BillingDocument {
  const currency = String(raw.currency ?? "USD");
  const customer = (raw.customer_details ?? {}) as { name?: string; email?: string | null; vat_number?: string | null; billing_address?: Record<string, string | null> | null };
  const address = customer.billing_address ?? {};
  const country = address.country ?? null;
  const india = country === "IN";
  const stateCode = india ? Object.entries(INDIAN_STATES).find(([, name]) => name === address.state)?.[0] : undefined;
  const breakdown = (raw.tax_breakdown ?? []) as { name: string; tax_rate: string; tax_amount: number; exemption_type?: string | null; exemption_reason?: string | null }[];
  return {
    seller,
    number: String(raw.invoice_number ?? ""),
    issuedOn: String(raw.invoice_date ?? raw.created_at ?? "").slice(0, 10),
    dueOn: String(raw.due_date ?? raw.invoice_date ?? "").slice(0, 10),
    currency,
    buyer: {
      name: customer.name || orgName,
      // Meteroid prints no state, so line 2 ends with it ("…, Tamil Nadu (33)"): shown after the city, as addresses read.
      lines: (() => {
        const state = india ? address.line2?.match(/(?:^|,\s*)([^,]+\(\d{2}\))$/)?.[1] ?? null : null;
        const line2 = state ? address.line2!.slice(0, address.line2!.length - state.length).replace(/,\s*$/, "") : address.line2;
        return [address.line1, line2, [address.city, address.zip_code].filter(Boolean).join(" "), state, country ? countryName(country) ?? country : null];
      })().filter((line): line is string => !!line),
      email: customer.email ?? null,
      taxLabel: india ? "GSTIN" : "Tax ID",
      taxId: customer.vat_number || null,
    },
    placeOfSupply: india ? `${address.state ?? "India"}${stateCode ? ` (${stateCode})` : ""}` : "Outside India (export of services)",
    forWhom: customer.name || orgName,
    lines: (raw.line_items ?? []).map((line) => {
      const quantity = Number(line.quantity ?? 1);
      const unit = Number(line.unit_price ?? 0);
      return {
        description: describe(String(line.name ?? ""), line.description, quantity),
        detail: [`SAC ${SAC}`, period(line.start_date, line.end_date)].filter(Boolean).join(" · "),
        quantity: String(quantity),
        unitPrice: money(Math.round(unit * 10_000) / 100, currency, 4),
        amountCents: Math.round(quantity * unit * 100),
      };
    }),
    subtotalCents: Number(raw.subtotal ?? 0),
    taxes: breakdown.filter((tax) => !tax.exemption_type && tax.tax_amount > 0)
      .map((tax) => ({ label: `${tax.name} ${Number((Number(tax.tax_rate) * 100).toFixed(2))}%`, cents: tax.tax_amount })),
    totalCents: Number(raw.total ?? 0),
    exemption: country && country !== "IN"
      ? [EXPORT_DECLARATION, `LUT ARN: ${seller.lutArn || "(to be added in Meteroid › Invoicing entity › legal footer)"}`]
      : breakdown.some((tax) => tax.exemption_type) ? [breakdown.find((tax) => tax.exemption_type)?.exemption_reason ?? "Exempt from GST"] : null,
    payments: (raw.transactions ?? [])
      .filter((tx) => tx.status === "SETTLED" && tx.payment_type !== "REFUND")
      .map((tx) => ({
        method: tx.provider_transaction_id && tx.provider_transaction_id in methods
          ? `${METHOD[methods[tx.provider_transaction_id] ?? ""] ?? "Online"} (Razorpay)`
          : "Bank transfer",
        reference: tx.provider_transaction_id ?? "", paidOn: String(tx.processed_at ?? "").slice(0, 10), cents: Number(tx.amount ?? 0) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing

/** Standard fonts are WinAnsi only: anything else (a name in another script) is replaced, never a crash. */
const WIN_ANSI = /[^\x20-\x7E\u00A0-\u00FF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;
const safe = (value: string) => value.replace(WIN_ANSI, "?");

/** "US$5.37" (Stripe's style), "€300.00"; a symbol the font can't print (₹) as its code: "INR 25,000.00". */
export function money(cents: number, currency: string, maxDecimals = 2) {
  const format = (display: "symbol" | "code") => new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-GB", {
    style: "currency", currency, currencyDisplay: display, minimumFractionDigits: 2, maximumFractionDigits: maxDecimals,
  }).format(cents / 100).replace(/\u00A0/g, " ");
  const symbol = format("symbol");
  WIN_ANSI.lastIndex = 0;
  return WIN_ANSI.test(symbol) ? format("code") : symbol;
}

/** The TrainerTwin mark (public/trainertwin-mark.svg), brand orange. */
const MARK = "M172.891 80C165.711 80 159.891 85.8203 159.891 93L159.891 146.922C159.891 154.102 165.711 159.922 172.891 159.922L227 159.922C234.18 159.922 240 165.742 240 172.922L240 227.031C240 234.211 234.18 240.031 227 240.031L172.891 240.031C165.711 240.031 159.891 234.211 159.891 227.031L159.891 172.926C159.891 165.746 154.07 159.926 146.891 159.926L93.7734 159.926C86.5937 159.926 80.7734 165.746 80.7734 172.926L80.7734 227.031C80.7734 234.211 74.9531 240.031 67.7734 240.031L13.6641 240.031C6.48436 240.031 0.664063 234.211 0.664063 227.031L0.664065 172.922C0.664066 165.742 6.48436 159.922 13.6641 159.922L66.7813 159.922C73.961 159.922 79.7813 154.102 79.7813 146.922L79.7813 93C79.7813 85.8203 73.961 80 66.7813 80L13 80C5.82031 80 7.2496e-06 74.1797 7.56343e-06 67L9.92385e-06 13C1.02377e-05 5.8203 5.82031 2.5441e-07 13 5.68245e-07L227 9.92248e-06C234.18 1.02363e-05 240 5.82031 240 13L240 67C240 74.1797 234.18 80 227 80L172.891 80Z";

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.45, 0.45, 0.45);
const RULE = rgb(0.85, 0.85, 0.85);
const WIDTH = 595.28; // A4
const HEIGHT = 841.89;
const LEFT = 42;
const RIGHT = WIDTH - 42;

type Fonts = { regular: PDFFont; bold: PDFFont };

class Sheet {
  constructor(readonly page: PDFPage, readonly fonts: Fonts) {}
  text(value: string, x: number, y: number, options: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {}) {
    const font = options.bold ? this.fonts.bold : this.fonts.regular;
    const size = options.size ?? 8.5;
    const clean = safe(value);
    const at = options.align === "right" ? x - font.widthOfTextAtSize(clean, size) : x;
    this.page.drawText(clean, { x: at, y, size, font, color: options.color ?? INK });
  }
  width(value: string, size = 8.5) {
    return this.fonts.regular.widthOfTextAtSize(safe(value), size);
  }
  /** A clickable area (the Pay online link). */
  link(url: string, x: number, y: number, width: number, height: number) {
    const context = this.page.doc.context;
    const annotation = context.register(context.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, y, x + width, y + height], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }));
    this.page.node.addAnnot(annotation);
  }
  rule(y: number, from = LEFT, to = RIGHT, thickness = 0.6, color = RULE) {
    this.page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color });
  }
  /** Words wrapped to `width`; returns the lines. */
  wrap(value: string, width: number, size = 8.5) {
    const lines: string[] = [];
    let line = "";
    for (const word of safe(value).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.fonts.regular.widthOfTextAtSize(next, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
}

async function sheet(title: string, doc: BillingDocument, meta: [string, string][]) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([WIDTH, HEIGHT]);
  const s = new Sheet(page, { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) });
  page.drawRectangle({ x: 0, y: HEIGHT - 4, width: WIDTH, height: 4, color: INK });
  s.text(title, LEFT, HEIGHT - 52, { bold: true, size: 20 });
  page.drawSvgPath(MARK, { x: RIGHT - 34, y: HEIGHT - 30, scale: 34 / 240, color: rgb(0.925, 0.188, 0.075) });

  let y = HEIGHT - 76;
  for (const [label, value] of meta) {
    s.text(label, LEFT, y, { bold: true });
    s.text(value, LEFT + 92, y);
    y -= 13;
  }

  y -= 14;
  const top = y;
  const seller = doc.seller;
  s.text(seller.name, LEFT, y, { bold: true });
  const sellerLines = [seller.line1, seller.line2, [seller.city, seller.zip].filter(Boolean).join(" "), countryName(seller.country) ?? seller.country, `GSTIN ${seller.gstin}`, seller.email];
  for (const line of sellerLines.filter(Boolean)) s.text(line, LEFT, (y -= 13));
  let by = top;
  const col = 260;
  s.text("Bill to", col, by, { bold: true });
  s.text(doc.buyer.name, col, (by -= 13));
  for (const line of doc.buyer.lines) s.text(line, col, (by -= 13));
  if (doc.buyer.taxId) s.text(`${doc.buyer.taxLabel} ${doc.buyer.taxId}`, col, (by -= 13));
  if (doc.buyer.email) s.text(doc.buyer.email, col, (by -= 13));
  return { pdf, s, y: Math.min(y, by) - 34 };
}

/** The lines table and the totals; returns where it ended. `last`: the bold closing row ("Amount due", "Amount paid"). */
function linesAndTotals(s: Sheet, doc: BillingDocument, y: number, last: [string, number]) {
  const qtyX = 400, unitX = 480, amountX = RIGHT;
  s.text("Description", LEFT, y, { size: 7.5 });
  s.text("Qty", qtyX, y, { size: 7.5, align: "right" });
  s.text("Unit price", unitX, y, { size: 7.5, align: "right" });
  s.text("Amount", amountX, y, { size: 7.5, align: "right" });
  s.rule(y - 5, LEFT, RIGHT, 1, INK);
  y -= 20;
  for (const line of doc.lines) {
    const wrapped = s.wrap(line.description, qtyX - LEFT - 40);
    s.text(line.quantity, qtyX, y, { align: "right" });
    s.text(line.unitPrice, unitX, y, { align: "right" });
    s.text(money(line.amountCents, doc.currency), amountX, y, { align: "right" });
    for (const [index, part] of wrapped.entries()) s.text(part, LEFT, y - index * 12);
    y -= wrapped.length * 12;
    s.text(line.detail, LEFT, y, { color: MUTED, size: 8 });
    y -= 12;
    s.rule(y + 2);
    y -= 14;
  }
  const label = 330;
  const rows: [string, number, boolean][] = [
    ["Subtotal (taxable value)", doc.subtotalCents, false],
    ...doc.taxes.map((tax): [string, number, boolean] => [tax.label, tax.cents, false]),
    ["Total", doc.totalCents, false],
    [last[0], last[1], true],
  ];
  for (const [name, cents, bold] of rows) {
    s.text(name, label, y, { bold });
    s.text(money(cents, doc.currency), amountX, y, { align: "right", bold });
    s.rule(y - 5, label, RIGHT);
    y -= 16;
  }
  if (doc.exemption) {
    y -= 6;
    for (const part of doc.exemption.flatMap((line) => s.wrap(line, RIGHT - label))) {
      s.text(part, label, y, { color: MUTED, size: 8 });
      y -= 11;
    }
  }
  return y;
}

function footer(s: Sheet, left: string, note: string) {
  s.text(note, LEFT, 60, { color: MUTED, size: 7.5 });
  s.rule(50);
  s.text(left, LEFT, 36, { size: 7.5 });
  s.text("Page 1 of 1", RIGHT, 36, { size: 7.5, align: "right" });
}

async function finish(pdf: PDFDocument, title: string, at: Date, author: string) {
  // The same document renders the same bytes (dates from it, not the clock): an emailed copy can be retried.
  pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setProducer("TrainerTwin");
  pdf.setCreator("TrainerTwin");
  pdf.setCreationDate(at);
  pdf.setModificationDate(at);
  return Buffer.from(await pdf.save());
}

/** The tax invoice. Under the amount, while it's unpaid: `payUrl` (Razorpay's page, "Pay online"). */
export async function renderInvoice(doc: BillingDocument, payUrl?: string | null, unpaid = !!payUrl) {
  const { pdf, s, y: start } = await sheet("Invoice", doc, [
    ["Invoice number", doc.number],
    ["Date of issue", longDay(doc.issuedOn)],
    ["Date due", longDay(doc.dueOn)],
    ["Place of supply", doc.placeOfSupply],
  ]);
  let y = start;
  const due = `${money(doc.totalCents, doc.currency)} due ${longDay(doc.dueOn)}`;
  s.text(due, LEFT, y, { bold: true, size: 14 });
  y -= 20;
  if (payUrl) {
    s.text("Pay online", LEFT, y, { bold: true, color: rgb(0.3, 0.33, 0.9) });
    s.text(payUrl, LEFT + 62, y, { color: rgb(0.3, 0.33, 0.9) });
    s.link(payUrl, LEFT, y - 3, 62 + s.width(payUrl), 13);
    y -= 22;
  } else if (unpaid) {
    s.text(`To pay, write to ${doc.seller.email || "us"} for a payment link, quoting ${doc.number}.`, LEFT, y);
    y -= 22;
  }
  s.text(`Invoice for ${doc.forWhom}`, LEFT, y);
  linesAndTotals(s, doc, y - 32, ["Amount due", doc.totalCents]);
  footer(s, `${doc.number} · ${due}`, "This is a computer-generated invoice and needs no signature. Prices include GST where it applies.");
  return finish(pdf, `Invoice ${doc.number}`, new Date(`${doc.issuedOn}T00:00:00Z`), doc.seller.name);
}

/** The payment receipt: the invoice's lines and totals, and the payments that settled it. */
export async function renderReceipt(doc: BillingDocument, paidAt: Date) {
  const paidOn = longDay(paidAt.toISOString());
  const { pdf, s, y: start } = await sheet("Receipt", doc, [
    ["Invoice number", doc.number],
    ["Receipt number", receiptNumber(doc.number)],
    ["Date paid", paidOn],
    ["Place of supply", doc.placeOfSupply],
  ]);
  let y = start;
  s.text(`${money(doc.totalCents, doc.currency)} paid on ${paidOn}`, LEFT, y, { bold: true, size: 14 });
  y -= 20;
  s.text(`Invoice for ${doc.forWhom}`, LEFT, y);
  y = linesAndTotals(s, doc, y - 32, ["Amount paid", doc.totalCents]);

  y -= 26;
  s.text("Payment history", LEFT, y, { bold: true, size: 13 });
  y -= 26;
  const cols = { date: 300, amount: 440, receipt: RIGHT };
  s.text("Payment method", LEFT, y, { size: 7.5 });
  s.text("Date", cols.date, y, { size: 7.5 });
  s.text("Amount paid", cols.amount, y, { size: 7.5, align: "right" });
  s.text("Receipt number", cols.receipt, y, { size: 7.5, align: "right" });
  s.rule(y - 5, LEFT, RIGHT, 1, INK);
  y -= 20;
  const payments = doc.payments.length ? doc.payments : [{ method: "Bank transfer", reference: "", paidOn: paidAt.toISOString().slice(0, 10), cents: doc.totalCents }];
  for (const payment of payments) {
    s.text([payment.method, payment.reference].filter(Boolean).join(" · "), LEFT, y);
    s.text(longDay(payment.paidOn), cols.date, y);
    s.text(money(payment.cents, doc.currency), cols.amount, y, { align: "right" });
    s.text(receiptNumber(doc.number), cols.receipt, y, { align: "right" });
    y -= 18;
  }
  footer(s, `${receiptNumber(doc.number)} · paid ${paidOn}`, "This receipt confirms payment of the invoice above, which is the tax invoice.");
  return finish(pdf, `Receipt ${receiptNumber(doc.number)}`, paidAt, doc.seller.name);
}
