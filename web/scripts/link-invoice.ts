/**
 * Links a GST invoice made in the Razorpay Dashboard to the org and the credits it buys. Paying it adds the credits
 * (webhook); an invoice already paid adds them now.
 *
 *   bun scripts/link-invoice.ts --invoice inv_XXXXXXXX --org careerwithvasanth --credits 1000
 *
 * Against a production database it also needs --production, and live keys.
 */
import { formatMoney, linkInvoicePurchase } from "@/lib/credit-purchases";
import { db } from "@/lib/db";
import { checkScriptKeys } from "./razorpay-script-guard";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const invoiceId = arg("invoice");
const slug = arg("org");
const credits = Number(arg("credits"));
if (!invoiceId || !slug || !credits) throw new Error("usage: bun scripts/link-invoice.ts --invoice <inv_…> --org <slug> --credits <n> [--note <text>]");
checkScriptKeys(args);

const org = await db.organization.findUnique({ where: { slug }, select: { id: true } });
if (!org) throw new Error(`No org "${slug}"`);
const purchase = await linkInvoicePurchase({ org, invoiceId, credits, note: arg("note") });
console.log(`${slug}: ${credits} credits for ${formatMoney(purchase.amount, purchase.currency)} · invoice ${purchase.razorpayId} · ${purchase.status === "paid" ? "already paid: credits added" : "credits added when it's paid"}`);
await db.$disconnect();
