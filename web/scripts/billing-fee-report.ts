/**
 * The month's Razorpay payments for invoices, for the accountant (specs/billing.md rule 34): one CSV row per payment
 * with the invoice, org, amount and currency, the INR it converted to, Razorpay's fee and the GST on it, what was
 * settled, the method, and Razorpay's settlement id and date once settled. Fees Razorpay hadn't reported when the
 * payment arrived are read now (and saved). Duplicates (paid twice, to refund) are listed too, marked.
 *
 *   bun scripts/billing-fee-report.ts --month 2026-11 > fees-2026-11.csv
 */
import { db } from "@/lib/db";
import { fetchPayment, settlementRecon } from "@/lib/razorpay";

const month = process.argv[process.argv.indexOf("--month") + 1] ?? "";
const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
if (!process.argv.includes("--month") || !match) throw new Error("Use --month YYYY-MM");
const [year, monthNumber] = [Number(match[1]), Number(match[2])];
const from = new Date(Date.UTC(year, monthNumber - 1, 1));
const to = new Date(Date.UTC(year, monthNumber, 1));

const payments = await db.billingPayment.findMany({
  where: { paidAt: { gte: from, lt: to } },
  include: { invoice: { select: { number: true, billing: { select: { organization: { select: { slug: true } } } } } } },
  orderBy: { paidAt: "asc" },
});

// Fees Razorpay hadn't reported yet when the payment arrived.
for (const payment of payments.filter((p) => p.feeInr === null || p.amountInr === null || p.taxInr === null || p.method === null)) {
  const fresh = await fetchPayment(payment.id).catch(() => null);
  if (!fresh) continue;
  const data = { amountInr: fresh.base_amount ?? null, feeInr: fresh.fee ?? null, taxInr: fresh.tax ?? null, method: fresh.method, international: fresh.international };
  await db.billingPayment.update({ where: { id: payment.id }, data });
  Object.assign(payment, data);
}

// Settlements: this month's and next month's reconciliation (international payments settle about a week later).
const settled = new Map<string, { id: string | null; at: number | null }>();
for (const [y, m] of [[year, monthNumber], monthNumber === 12 ? [year + 1, 1] : [year, monthNumber + 1]]) {
  for (let skip = 0; ; skip += 1000) {
    const items = await settlementRecon(y, m, skip).catch(() => []);
    for (const item of items) if (item.type === "payment") settled.set(item.entity_id, { id: item.settlement_id, at: item.settled_at });
    if (items.length < 1000) break;
  }
}

const inr = (paise: number | null) => (paise === null ? "" : (paise / 100).toFixed(2));
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const rows = [[
  "paid_at", "razorpay_payment_id", "status", "invoice", "org", "amount", "currency", "amount_inr", "razorpay_fee_inr",
  "gst_on_fee_inr", "net_settled_inr", "method", "international", "settlement_id", "settled_at",
]];
for (const p of payments) {
  const settlement = settled.get(p.id);
  const net = p.amountInr !== null && p.feeInr !== null ? p.amountInr - p.feeInr : null; // Razorpay's fee includes its GST
  rows.push([
    p.paidAt.toISOString(), p.id, p.status, p.invoice.number, p.invoice.billing.organization.slug, (p.amount / 100).toFixed(2), p.currency,
    inr(p.amountInr), inr(p.feeInr), inr(p.taxInr), inr(net), p.method ?? "", p.international === null ? "" : String(p.international),
    settlement?.id ?? "", settlement?.at ? new Date(settlement.at * 1000).toISOString() : "",
  ]);
}
console.log(rows.map((row) => row.map(cell).join(",")).join("\n"));
console.error(`${payments.length} payments in ${month} (${payments.filter((p) => p.status === "duplicate").length} duplicates to refund)`);
await db.$disconnect();
