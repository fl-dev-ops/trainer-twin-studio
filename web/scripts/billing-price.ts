/**
 * Sets an org's custom Paid price (specs/billing.md rule 2), tax included, in USD a month, or clears it. It applies
 * when the org next upgrades (lib/billing/billing.ts requestUpgrade). An org already on Paid keeps its subscription's
 * price: change that in Meteroid (Subscription › Edit price) too. Prints the org's billing before and after.
 *
 *   bun scripts/billing-price.ts --org <slug> --monthly 250
 *   bun scripts/billing-price.ts --org <slug> --clear
 */
import { db } from "@/lib/db";
import { formatUsd, PAID_MONTHLY_CENTS } from "@/lib/billing/pricing";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const slug = value("--org");
const monthly = value("--monthly");
const clear = args.includes("--clear");
if (!slug || (!monthly && !clear) || (monthly && clear)) throw new Error("Use --org <slug> and either --monthly <USD> or --clear");
let cents: number | null = null;
if (monthly) {
  cents = Math.round(Number(monthly) * 100);
  if (!Number.isFinite(cents) || cents < 100 || Math.abs(cents - Number(monthly) * 100) > 1e-6) throw new Error("--monthly must be at least 1, with at most 2 decimals");
}
const org = await db.organization.findFirst({ where: { slug }, select: { id: true, name: true, billing: true } });
if (!org?.billing) throw new Error(`${slug}: no such org, or it isn't billed`);
const show = (c: number | null) => `${formatUsd(c ?? PAID_MONTHLY_CENTS)}${c ? " (custom)" : " (plan price)"}`;
console.log(`${org.name}: ${org.billing.plan}, Paid price ${show(org.billing.paidMonthlyCents)}`);
await db.orgBilling.update({ where: { orgId: org.id }, data: { paidMonthlyCents: cents } });
console.log(`now: Paid price ${show(cents)}${org.billing.plan === "paid" ? ". Already on Paid: also change the subscription's price in Meteroid." : ""}`);
await db.$disconnect();
