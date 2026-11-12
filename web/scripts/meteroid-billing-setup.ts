/**
 * Sets up Meteroid for billing (specs/billing.md), once per tenant (dev, sandbox, production); safe to run again.
 * Uses METEROID_API_KEY (the tenant) like the app. Production only with explicit go-ahead
 * (plans/billing-phase-2-release.md). Plans aren't made here: staff create each org's plan and subscription in
 * Meteroid (rule 10); every org starts on the Trial ("Credits") subscription.
 *   - MINS can be sold (product "Minute packs") at $0.25 (100 credits = $25: staff selling minutes in Meteroid's UI; the app sets its own net
 *     price per customer for tax-inclusive packs);
 *   - the invoicing entity (the seller on every invoice), when it isn't filled in yet: our address, GSTIN, SAC on the
 *     footer, 2-day payment terms, contact. Afterwards Meteroid is where the company's details are edited (and the
 *     LUT ARN, in the legal footer);
 *   - the app's webhook endpoint also gets invoice.finalized / paid / voided and subscription.cancelled / ended.
 * Customer emails are switched off separately (all 11 kinds, every tenant; done 11 Nov 2026 in Meteroid's database).
 *
 *   bun scripts/meteroid-billing-setup.ts --webhook-url https://dash.trainertwin.com/api/meteroid/webhook [--dry-run]
 */
import { meteroid } from "@/lib/meteroid";
import { defaultInvoicingEntity, meteroidGrpc } from "@/lib/billing/meteroid";
import { PACK_CENTS, PACK_CREDITS } from "@/lib/billing/pricing";
import { SAC } from "@/lib/billing/documents";

/**
 * The company as first set on a tenant's invoicing entity. Meteroid is the source afterwards: edit it there
 * (Settings › Invoicing entity); invoices and receipts read it from Meteroid (lib/billing/meteroid.ts sellerDetails).
 */
/** Days an invoice is due after it's issued, as first set on the entity (packs; each plan or subscription sets its own). */
const NET_TERMS = 2;

const SELLER = {
  name: "Forever Learning Solutions Pvt Ltd",
  // As on the GST registration (LUT form RFD-11, 11 Nov 2026).
  line1: "52/2A1, School Street, Right Side",
  line2: "Selaiyur, Chengalpattu, Tamil Nadu (33)",
  city: "Chennai",
  zip: "600073",
  state: "Tamil Nadu",
  gstin: "33AAGCF6592D1ZN",
  email: "billing@trainertwin.com",
};
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

const family = (await meteroid<Page<{ id: string }>>("GET", "/product_families")).data?.[0]?.id;
if (!family) throw new Error("Meteroid has no product family; create one in its UI first");

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

// 3. The invoicing entity (gRPC: the REST API has no invoicing-entity endpoint): filled in once. Meteroid is the source
//    of the company's details afterwards; a re-run never overwrites edits made there.
// Read first; a failed read stops here rather than risk writing over the company's details.
const entity = await defaultInvoicingEntity();
if (entity.gstin) done.push(`ok: invoicing entity filled in (${entity.name}, GSTIN ${entity.gstin}); edit it in Meteroid`);
else await step(`invoicing entity ${entity.id}: address, GSTIN ${SELLER.gstin}, SAC footer, net ${NET_TERMS} days, contact ${SELLER.email}`, () =>
  meteroidGrpc("meteroid.api.invoicingentities.v1.InvoicingEntitiesService", "UpdateInvoicingEntity", [
    [1, entity.id],
    [2, [
      [4, SELLER.name],
      [9, NET_TERMS],
      [10, `SAC ${SAC} (online education and training services). Prices include GST where it applies.`],
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
