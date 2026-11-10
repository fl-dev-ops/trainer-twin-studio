/**
 * Bills an org through Meteroid: links it to a Meteroid customer (alias = the org's slug; created when missing),
 * makes sure the customer has a subscription that counts voice minutes (plan "Credits", scripts/meteroid-setup.ts),
 * and optionally adds minutes. From then on the org's credits are Meteroid's (lib/org-credits.ts). Safe to run again:
 * the grant is made once per --grant-key.
 *
 *   bun scripts/meteroid-link-org.ts --org olga
 *   bun scripts/meteroid-link-org.ts --org olga --minutes 1000 --expires 2027-11-09 --reason "Complimentary minutes"
 *
 * Production database: add --production (and use a production Meteroid key).
 */
import { db } from "@/lib/db";
import { grantMinutes, meteroid, MeteroidError, USAGE_METRIC } from "@/lib/meteroid";
import { refreshOrgCredits } from "@/lib/org-credits";
import { isRemoteDatabase } from "./razorpay-script-guard";

const USAGE = 'usage: bun scripts/meteroid-link-org.ts --org <slug> [--minutes <n> --expires <YYYY-MM-DD> --reason "<why>" [--grant-key <key>]] [--production]';
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const slug = arg("org");
const minutes = arg("minutes") === undefined ? 0 : Number(arg("minutes"));
const expires = arg("expires");
const reason = arg("reason");
if (!slug || !Number.isInteger(minutes) || minutes < 0 || (minutes > 0 && !(expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) && reason))) throw new Error(USAGE);

const sandboxKey = (process.env.METEROID_API_KEY ?? "").startsWith("pv_dev_");
if (isRemoteDatabase() && !args.includes("--production")) throw new Error("refusing: this is a production database; add --production to write to it");
if (isRemoteDatabase() && sandboxKey) throw new Error("refusing: a production database needs a production Meteroid key (not pv_dev_…)");
if (!isRemoteDatabase() && !sandboxKey) throw new Error("refusing: a production Meteroid key with a local database");

const org = await db.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
if (!org) throw new Error(`No org "${slug}"`);

type Page<T> = { data?: T[] };
const customer = await meteroid<{ id: string }>("GET", `/customers/${encodeURIComponent(slug)}`).catch(async (error: unknown) => {
  if (!(error instanceof MeteroidError && error.status === 404)) throw error;
  return meteroid<{ id: string }>("POST", "/customers", { name: org.name, alias: slug, currency: "USD", customer_type: "COMPANY" });
});

// A subscription whose plan counts voice minutes: without one, usage spends nothing.
const metric = ((await meteroid<Page<{ id: string; code: string; archived_at?: string | null }>>("GET", "/metrics?per_page=100")).data ?? [])
  .find((m) => m.code === USAGE_METRIC && !m.archived_at);
if (!metric) throw new Error("Meteroid has no voice_minutes metric: run scripts/meteroid-setup.ts first");
const subscriptions = (await meteroid<Page<{ id: string; plan_id: string; status: string }>>("GET", `/subscriptions?customer_id=${customer.id}&per_page=50`)).data ?? [];
let counting: string | undefined;
for (const sub of subscriptions.filter((s) => ["ACTIVE", "TRIALING", "PENDING_ACTIVATION"].includes(s.status))) {
  const plan = await meteroid<{ price_components?: { fee?: { metric_id?: string } }[] }>("GET", `/plans/${sub.plan_id}`);
  if (plan.price_components?.some((c) => c.fee?.metric_id === metric.id)) counting = sub.id;
}
if (!counting) {
  const plan = ((await meteroid<Page<{ id: string; name: string }>>("GET", "/plans?per_page=100")).data ?? []).find((p) => p.name === "Credits");
  if (!plan) throw new Error('Meteroid has no "Credits" plan: run scripts/meteroid-setup.ts first');
  const sub = await meteroid<{ id?: string; subscription?: { id: string } }>("POST", "/subscriptions", {
    customer_id_or_alias: slug, plan_id: plan.id, start_date: new Date().toISOString().slice(0, 10),
    activation_condition: "ON_START", charge_automatically: false,
  });
  counting = sub.id ?? sub.subscription?.id;
}

await db.orgBilling.upsert({ where: { orgId: org.id }, create: { orgId: org.id, meteroidCustomerId: customer.id }, update: { meteroidCustomerId: customer.id } });
if (minutes > 0) {
  await grantMinutes({
    customerId: customer.id, minutes, type: "PROMOTIONAL", reason: reason!,
    expiresAt: new Date(`${expires}T23:59:59Z`), idempotencyKey: arg("grant-key") ?? `link-${slug}-${minutes}-${expires}`,
  });
}
await new Promise((resolve) => setTimeout(resolve, 3000)); // Meteroid counts a new grant within a few seconds
await refreshOrgCredits(org.id);
const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId: org.id } });
console.log(`${slug}: Meteroid customer ${customer.id} · subscription ${counting} · balance ${billing.balanceMinutes} min`);
await db.$disconnect();
