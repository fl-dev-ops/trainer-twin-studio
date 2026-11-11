/**
 * Sets up Meteroid for billing phase 2 (specs/billing.md), once per tenant (dev, sandbox, production); safe to run
 * again. Uses METEROID_API_KEY (the tenant) like the app. Production only with explicit go-ahead
 * (plans/billing-phase-2-release.md).
 *   - plan "Paid": $300 a month, tax included, due 2 days after each invoice, no credits;
 *   - MINS can be sold (product "Minute packs") at $0.25 (100 credits = $25: staff selling minutes in Meteroid's UI; the app sets its own net
 *     price per customer for tax-inclusive packs);
 *   - the invoicing entity (the seller on every invoice): our address, GSTIN, SAC on the footer, 2-day terms, contact;
 *   - the app's webhook endpoint also gets invoice.finalized / paid / voided and subscription.cancelled / ended.
 * Customer emails are switched off separately (all 11 kinds, every tenant; done 11 Nov 2026 in Meteroid's database).
 *
 *   bun scripts/meteroid-billing-setup.ts --webhook-url https://dash.trainertwin.com/api/meteroid/webhook [--dry-run]
 */
import { meteroid } from "@/lib/meteroid";
import { meteroidGrpc, PAID_NET_TERMS, PAID_PLAN } from "@/lib/billing/meteroid";
import { PAID_MONTHLY_CENTS, PACK_CENTS, PACK_CREDITS } from "@/lib/billing/pricing";
import { SELLER } from "@/lib/billing/documents";
import { CREDIT_UNIT } from "@/lib/meteroid";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const webhookUrl = args[args.indexOf("--webhook-url") + 1];
if (!args.includes("--webhook-url") || !webhookUrl?.startsWith("https://")) throw new Error("Pass --webhook-url https://…/api/meteroid/webhook (the app's endpoint in this tenant)");

const WEBHOOK_EVENTS = [
  "wallet.funded", "wallet.debited", "wallet.depleted", "wallet.recovered", "credit_grant.expired",
  "invoice.finalized", "invoice.paid", "invoice.voided", "subscription.cancelled", "subscription.ended",
];

type Page<T> = { data?: T[] };
const done: string[] = [];
const step = async (what: string, run: () => Promise<unknown>) => {
  if (dryRun) return void done.push(`would: ${what}`);
  await run();
  done.push(`done: ${what}`);
};

// 1. The Paid plan.
const family = (await meteroid<Page<{ id: string }>>("GET", "/product_families")).data?.[0]?.id;
if (!family) throw new Error("Meteroid has no product family; create one in its UI first");
const plans = (await meteroid<Page<{ id: string; name: string; status: string }>>("GET", "/plans?per_page=100")).data ?? [];
const paid = plans.find((plan) => plan.name === PAID_PLAN && plan.status === "ACTIVE");
if (paid) done.push(`ok: plan "${PAID_PLAN}" exists (${paid.id})`);
else await step(`create plan "${PAID_PLAN}" ($${PAID_MONTHLY_CENTS / 100}/month, tax included, net ${PAID_NET_TERMS} days)`, () => meteroid("POST", "/plans", {
  name: PAID_PLAN, product_family_id: family, plan_type: "STANDARD", status: "ACTIVE", currency: "USD", tax_inclusive: true,
  description: "TrainerTwin Paid plan: monthly, tax included, no credits (credits come from minute packs)",
  billing: { net_terms: PAID_NET_TERMS },
  components: [{ name: "TrainerTwin Paid plan", fee: { type: "RATE", rates: [{ term: "MONTHLY", price: (PAID_MONTHLY_CENTS / 100).toFixed(2) }] } }],
}));

// 2. The credit unit can be sold (a product its sales are booked under), at a USD price.
const units = (await meteroid<Page<{ id: string; code: string; product_id: string | null }>>("GET", "/credit-units")).data ?? [];
const unit = units.find((u) => u.code === CREDIT_UNIT);
if (!unit) throw new Error(`Meteroid has no ${CREDIT_UNIT} credit unit: run scripts/meteroid-setup.ts first`);
const PACK_PRODUCT = "Minute packs";
if (unit.product_id) done.push(`ok: ${CREDIT_UNIT} is sold under product ${unit.product_id}`);
else {
  const products = (await meteroid<Page<{ id: string; name: string; fee_type: string }>>("GET", "/products?per_page=100")).data ?? [];
  const existing = products.find((product) => product.name === PACK_PRODUCT && product.fee_type === "CREDIT");
  await step(`sell ${CREDIT_UNIT} under product "${PACK_PRODUCT}"${existing ? ` (${existing.id})` : " (new)"}`, async () => {
    const product = existing ?? await meteroid<{ id: string }>("POST", "/products", {
      name: PACK_PRODUCT, product_family_id: family, fee_structure: { type: "CREDIT" }, catalog: true,
      description: "Practice minutes (1 credit = 1 minute), sold in packs of 100",
    });
    await meteroid("PATCH", `/credit-units/${unit.id}`, { product_id: product.id });
  });
}
const unitPrice = (PACK_CENTS / 100 / PACK_CREDITS).toFixed(2);
const prices = (await meteroid<Page<{ currency: string; unit_price: string; archived_at: string | null }>>("GET", `/credit-units/${unit.id}/prices`)).data ?? [];
if (prices.some((price) => price.currency === "USD" && !price.archived_at && Number(price.unit_price) === Number(unitPrice))) done.push(`ok: ${CREDIT_UNIT} costs $${unitPrice}`);
else await step(`set ${CREDIT_UNIT} price to $${unitPrice}`, () => meteroid("PUT", `/credit-units/${unit.id}/prices/USD`, { unit_price: unitPrice }));

// 3. The invoicing entity (gRPC: the REST API has no invoicing-entity endpoint).
const someCustomer = (await meteroid<Page<{ invoicing_entity_id: string }>>("GET", "/customers?per_page=1")).data?.[0];
if (!someCustomer) throw new Error("No customer in this tenant to find the invoicing entity from");
await step(`invoicing entity ${someCustomer.invoicing_entity_id}: address, GSTIN ${SELLER.gstin}, SAC footer, net ${PAID_NET_TERMS} days, contact ${SELLER.email}`, () =>
  meteroidGrpc("meteroid.api.invoicingentities.v1.InvoicingEntitiesService", "UpdateInvoicingEntity", [
    [1, someCustomer.invoicing_entity_id],
    [2, [
      [4, SELLER.name],
      [9, PAID_NET_TERMS],
      [10, `SAC ${SELLER.sac} (online education and training services). Prices include GST where it applies.`],
      [14, SELLER.line1],
      [15, SELLER.line2],
      [16, SELLER.zip],
      [17, SELLER.state],
      [18, SELLER.city],
      [19, SELLER.gstin],
      [20, "IN"],
      [35, "TrainerTwin Billing"],
      [37, SELLER.email],
    ]],
  ]));

// 4. The app's webhook endpoint: the billing events too.
const endpoints = (await meteroid<Page<{ id: string; url: string; event_types: string[] }>>("GET", "/webhooks/endpoints")).data ?? [];
const endpoint = endpoints.find((e) => e.url === webhookUrl);
if (!endpoint) throw new Error(`No webhook endpoint for ${webhookUrl} in this tenant (found: ${endpoints.map((e) => e.url).join(", ") || "none"})`);
const missing = WEBHOOK_EVENTS.filter((event) => !endpoint.event_types.includes(event));
if (!missing.length) done.push(`ok: webhook ${endpoint.id} has every event`);
else await step(`webhook ${endpoint.id}: add ${missing.join(", ")}`, () => meteroid("PATCH", `/webhooks/endpoints/${endpoint.id}`, { event_types: [...new Set([...endpoint.event_types, ...WEBHOOK_EVENTS])] }));

console.log(done.join("\n"));
