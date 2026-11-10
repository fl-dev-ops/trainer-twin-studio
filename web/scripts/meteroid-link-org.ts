/**
 * Bills an existing org through Meteroid (new orgs are set up by onboarding, workflows/onboard-org.ts): links it to its
 * Meteroid customer and Credits subscription (lib/org-billing-setup.ts), and optionally adds minutes. From then on the org's credits are Meteroid's (lib/org-credits.ts). Safe to run again:
 * the grant is made once per --grant-key.
 *
 *   bun scripts/meteroid-link-org.ts --org olga
 *   bun scripts/meteroid-link-org.ts --org olga --trial 2026-11-11        the free trial (TRIAL_MINUTES for TRIAL_DAYS from that day)
 *   bun scripts/meteroid-link-org.ts --org olga --minutes 1000 --expires 2027-11-09 --reason "Complimentary minutes"
 *
 * Production database: add --production (and use a production Meteroid key).
 */
import { db } from "@/lib/db";
import { grantMinutes } from "@/lib/meteroid";
import { grantTrialMinutes, linkOrgToMeteroid } from "@/lib/org-billing-setup";
import { refreshOrgCredits } from "@/lib/org-credits";
import { isRemoteDatabase } from "./razorpay-script-guard";

const USAGE = 'usage: bun scripts/meteroid-link-org.ts --org <slug> [--trial <YYYY-MM-DD>] [--minutes <n> --expires <YYYY-MM-DD> --reason "<why>" [--grant-key <key>]] [--production]';
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const slug = arg("org");
const minutes = arg("minutes") === undefined ? 0 : Number(arg("minutes"));
const expires = arg("expires");
const reason = arg("reason");
const trial = arg("trial");
if (trial !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(trial)) throw new Error(USAGE);
if (!slug || !Number.isInteger(minutes) || minutes < 0 || (minutes > 0 && !(expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) && reason))) throw new Error(USAGE);

// Meteroid keys name their tenant: pv_prod_… (Production), pv_dev_… (Development), pv_sand_… (Sandbox, rehearsals).
const productionKey = (process.env.METEROID_API_KEY ?? "").startsWith("pv_prod_");
if (isRemoteDatabase() && !args.includes("--production")) throw new Error("refusing: this is a production database; add --production to write to it");
if (isRemoteDatabase() && !productionKey) throw new Error("refusing: a production database needs a production Meteroid key (pv_prod_…)");
if (!isRemoteDatabase() && productionKey) throw new Error("refusing: a production Meteroid key with a local database");

const org = await db.organization.findUnique({ where: { slug }, select: { id: true, name: true, createdAt: true } });
if (!org) throw new Error(`No org "${slug}"`);

const { customerId, subscriptionId } = await linkOrgToMeteroid({ id: org.id, slug, name: org.name });
if (trial) await grantTrialMinutes(org, customerId, new Date(`${trial}T00:00:00Z`));
if (minutes > 0) {
  await grantMinutes({
    customerId, minutes, type: "PROMOTIONAL", reason: reason!,
    expiresAt: new Date(`${expires}T23:59:59Z`), idempotencyKey: arg("grant-key") ?? `link-${slug}-${minutes}-${expires}`,
  });
}
await new Promise((resolve) => setTimeout(resolve, 3000)); // Meteroid counts a new grant within a few seconds
await refreshOrgCredits(org.id);
const billing = await db.orgBilling.findUniqueOrThrow({ where: { orgId: org.id } });
console.log(`${slug}: Meteroid customer ${customerId} · subscription ${subscriptionId} · balance ${billing.balanceMinutes} min`);
await db.$disconnect();
