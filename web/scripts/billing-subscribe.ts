/**
 * Moves an org from Trial to its own paid plan (specs/billing.md rules 10–12): staff create the org's plan and its
 * subscription in Meteroid; the app picks up the first invoice (the upgrade), emails it with Pay now and shows it in
 * Settings › Billing. The org is Paid once that invoice is paid.
 *
 *   DATABASE_URL="$PROD" METEROID_API_KEY=$METEROID_PROD_API_KEY bun scripts/billing-subscribe.ts --org olga --price 300
 *       checks only: billing details, tax, no paid plan yet; prints what it would create
 *   ... --yes      creates the plan (or reuses one with the same name) and the subscription, then waits for the invoice
 *
 * Options: --name "Olga – $300/month" (default "<org name> – $<price>/month"), --net-terms 2 (days to pay).
 * Prices are monthly, USD, tax included. Changing or ending a plan is done in Meteroid (issue #19).
 */
import { parseArgs } from "node:util";
import { db } from "@/lib/db";
import { detailsOf } from "@/lib/billing/billing";
import { countryName, taxFor } from "@/lib/billing/details";
import { TRIAL_PLAN } from "@/lib/billing/meteroid";
import { meteroid } from "@/lib/meteroid";

const { values: args } = parseArgs({
  options: { org: { type: "string" }, price: { type: "string" }, name: { type: "string" }, "net-terms": { type: "string", default: "2" }, yes: { type: "boolean", default: false } },
});
const fail = (message: string): never => { console.error(`STOP: ${message}`); process.exit(1); };
if (!args.org || !args.price) fail("usage: --org <slug> --price <USD per month> [--yes]");
const price = Number(args.price);
if (!(price > 0) || Math.round(price * 100) !== price * 100) fail(`--price must be a positive amount in dollars, e.g. 300 (got ${args.price})`);
const netTerms = Number(args["net-terms"]);
if (!Number.isInteger(netTerms) || netTerms < 0 || netTerms > 90) fail("--net-terms must be 0–90 days");

const org = await db.organization.findFirst({ where: { slug: args.org }, select: { id: true, name: true, slug: true } });
if (!org) fail(`no org with slug "${args.org}"`);
const billing = await db.orgBilling.findUnique({ where: { orgId: org!.id } });
if (!billing) fail(`${org!.slug} is not linked to Meteroid`);
if (billing!.plan !== "trial" || billing!.paidSubscriptionId) fail(`${org!.slug} already has a paid plan, or one waiting for payment (subscription ${billing!.paidSubscriptionId}); change it in Meteroid`);

// Billing details first: they decide the tax, where the invoice goes, and Razorpay needs the phone for Pay now.
const details = detailsOf(billing!);
if (!details) fail(`${org!.slug} has no billing details yet: their admin adds them in Settings › Billing`);
if (!details!.phone) fail(`${org!.slug}'s billing details have no phone: Pay now needs one (Settings › Billing › Edit)`);
const tax = taxFor(details!);

type Sub = { id: string; status: string; plan_name?: string; plan_id?: string };
const subs = (await meteroid<{ data: Sub[] }>("GET", `/subscriptions?customer_id=${billing!.meteroidCustomerId}&per_page=50`)).data ?? [];
const live = subs.filter((s) => ["ACTIVE", "PENDING_ACTIVATION", "PENDING_CHARGE", "TRIAL_ACTIVE"].includes(s.status) && s.plan_name !== TRIAL_PLAN);
if (live.length) fail(`${org!.slug} already has a live subscription in Meteroid: ${live.map((s) => `${s.id} (${s.plan_name}, ${s.status})`).join(", ")}`);

const planName = args.name ?? `${org!.name} – $${price}/month`;
const plans = (await meteroid<{ data: { id: string; name: string; currency: string }[] }>("GET", `/plans?search=${encodeURIComponent(planName)}&per_page=50`)).data ?? [];
const existing = plans.find((p) => p.name === planName);

console.log(`Org:        ${org!.name} (${org!.slug}), Meteroid customer ${billing!.meteroidCustomerId}`);
console.log(`Bill to:    ${details!.legalName}, ${[details!.line1, details!.line2, details!.city, details!.postalCode].filter(Boolean).join(", ")}, ${countryName(details!.country)}${details!.taxId ? `, tax no. ${details!.taxId}` : ""}`);
console.log(`Emails to:  ${details!.emails.join(", ")}   phone ${details!.phone}`);
console.log(`Tax:        ${tax.kind === "export" ? "export: no GST, LUT declaration and ARN on the invoice" : tax.lines.map((l) => `${l.name} ${l.bp / 100}%`).join(" + ") + " (included in the price)"}`);
console.log(`Plan:       "${planName}" — US$${price.toFixed(2)} a month, tax included, due ${netTerms} days after issue ${existing ? `(exists: ${existing.id})` : "(new)"}`);
console.log(`Subscribe:  from today; the first invoice (US$${price.toFixed(2)}) is emailed with Pay now; Paid once it's paid.`);
if (!args.yes) { console.log("\nChecks passed. Run again with --yes to create it."); process.exit(0); }

const family = (await meteroid<{ data: { id: string }[] }>("GET", "/product_families")).data[0]?.id ?? fail("no product family in this tenant");
const plan = existing ?? await meteroid<{ id: string }>("POST", "/plans", {
  name: planName, description: `org:${org!.slug}`, product_family_id: family, plan_type: "CUSTOM", status: "ACTIVE",
  currency: "USD", tax_inclusive: true, billing: { net_terms: netTerms },
  components: [{ name: "TrainerTwin plan", fee: { type: "RATE", rates: [{ term: "MONTHLY", price: price.toFixed(2) }] } }],
});
console.log(`\nplan ${plan.id} ${existing ? "reused" : "created"}`);
const created = await meteroid<{ id?: string; subscription?: { id: string } }>("POST", "/subscriptions", {
  customer_id_or_alias: billing!.meteroidCustomerId, plan_id: plan.id, start_date: new Date().toISOString().slice(0, 10),
  activation_condition: "ON_START", charge_automatically: false,
});
const subscriptionId = created.id ?? created.subscription?.id ?? fail(`unexpected reply: ${JSON.stringify(created)}`);
console.log(`subscription ${subscriptionId} created; waiting for the app to pick up the invoice…`);

// The app hears it from Meteroid's webhook (invoice.finalized) and starts the invoice-issued workflow.
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5_000));
  const row = await db.billingInvoice.findFirst({ where: { orgId: org!.id, subscriptionId } });
  if (row && row.paymentLinkUrl && row.issuedEmailAt) {
    console.log(`ok  ${row.number} (${row.kind}) US$${(row.totalCents / 100).toFixed(2)} — Pay now ${row.paymentLinkUrl}; emailed ${row.issuedEmailAt.toISOString()}`);
    console.log("It's on their Settings › Billing now (\"Upgrade waiting for payment\"). They're Paid as soon as it's paid.");
    process.exit(0);
  }
  if (row && i % 4 === 3) console.log(`… ${row.number} recorded; link ${row.paymentLinkUrl ? "made" : "pending"}, email ${row.issuedEmailAt ? "sent" : "pending"}`);
}
console.log("Not seen within 2 minutes. Check Meteroid › Webhooks deliveries; the daily check (00:15 UTC) also picks it up.");
process.exit(1);
