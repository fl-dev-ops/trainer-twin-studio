/**
 * A Razorpay payment link for credits at an org's agreed price, in INR or USD. Paying it adds the credits (webhook).
 *
 *   bun scripts/org-payment-link.ts --org careerwithvasanth --credits 1000 --amount 8000 --currency INR
 *   bun scripts/org-payment-link.ts --org acme --credits 1000 --amount 100 --currency USD \
 *     --email billing@acme.com --contact +14155550100 --name "Acme Inc"
 *
 * --email / --contact (phone) / --name: the payer; Razorpay sends them the link. USD needs --email and --contact, and
 * International Payments enabled on the Razorpay account. --note: kept on the purchase. A GST invoice can't be made through Razorpay's API: make it in the Dashboard and link it
 * (scripts/link-invoice.ts). Against a production database it also needs --production, and live keys.
 */
import { createPaymentLinkPurchase, formatMoney } from "@/lib/credit-purchases";
import { db } from "@/lib/db";
import { checkScriptKeys } from "./razorpay-script-guard";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const slug = arg("org");
const credits = Number(arg("credits"));
const amount = Number(arg("amount"));
const currency = (arg("currency") ?? "").toUpperCase();
if (!slug || !credits || !amount || !currency) {
  throw new Error("usage: bun scripts/org-payment-link.ts --org <slug> --credits <n> --amount <price> --currency INR|USD [--email <payer>] [--contact <phone>] [--name <payer name>] [--note <text>]");
}
checkScriptKeys(args);

const org = await db.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
if (!org) throw new Error(`No org "${slug}"`);
const payer = { email: arg("email"), contact: arg("contact"), name: arg("name") };
const purchase = await createPaymentLinkPurchase({ org, credits, amount, currency, payer, note: arg("note") });
console.log(`${slug}: ${credits} credits for ${formatMoney(purchase.amount, purchase.currency)}\n${purchase.url}\n(${purchase.razorpayId} · purchase ${purchase.id})`);
await db.$disconnect();
