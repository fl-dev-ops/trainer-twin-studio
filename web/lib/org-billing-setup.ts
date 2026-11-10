import { db } from "@/lib/db";
import { grantMinutes, meteroid, MeteroidError, USAGE_METRIC } from "@/lib/meteroid";
import { TRIAL_DAYS, TRIAL_MINUTES } from "@/lib/minutes-config";

/**
 * Setting an org up in Meteroid (lib/org-credits.ts): its customer (alias = the org's slug) and a subscription that
 * counts voice minutes (plan "Credits", scripts/meteroid-setup.ts). Used by the onboard-org workflow and
 * scripts/meteroid-link-org.ts. Safe to repeat.
 */

type Page<T> = { data?: T[] };
const CREDITS_PLAN = "Credits";

/** Links the org to its Meteroid customer, creating the customer and its Credits subscription when missing. */
export async function linkOrgToMeteroid(org: { id: string; slug: string; name: string }): Promise<{ customerId: string; subscriptionId: string }> {
  const customer = await meteroid<{ id: string }>("GET", `/customers/${encodeURIComponent(org.slug)}`).catch(async (error: unknown) => {
    if (!(error instanceof MeteroidError && error.status === 404)) throw error;
    return meteroid<{ id: string }>("POST", "/customers", { name: org.name, alias: org.slug, currency: "USD", customer_type: "COMPANY" });
  });
  const metric = ((await meteroid<Page<{ id: string; code: string; archived_at?: string | null }>>("GET", "/metrics?per_page=100")).data ?? [])
    .find((m) => m.code === USAGE_METRIC && !m.archived_at);
  if (!metric) throw new Error("Meteroid has no voice_minutes metric: run scripts/meteroid-setup.ts first");
  const subscriptions = (await meteroid<Page<{ id: string; plan_id: string; status: string }>>("GET", `/subscriptions?customer_id=${customer.id}&per_page=50`)).data ?? [];
  let subscriptionId: string | undefined;
  for (const sub of subscriptions.filter((s) => ["ACTIVE", "TRIALING", "PENDING_ACTIVATION"].includes(s.status))) {
    const plan = await meteroid<{ price_components?: { fee?: { metric_id?: string } }[] }>("GET", `/plans/${sub.plan_id}`);
    if (plan.price_components?.some((c) => c.fee?.metric_id === metric.id)) subscriptionId = sub.id;
  }
  if (!subscriptionId) {
    const plan = ((await meteroid<Page<{ id: string; name: string }>>("GET", "/plans?per_page=100")).data ?? []).find((p) => p.name === CREDITS_PLAN);
    if (!plan) throw new Error('Meteroid has no "Credits" plan: run scripts/meteroid-setup.ts first');
    const sub = await meteroid<{ id?: string; subscription?: { id: string } }>("POST", "/subscriptions", {
      customer_id_or_alias: org.slug, plan_id: plan.id, start_date: new Date().toISOString().slice(0, 10),
      activation_condition: "ON_START", charge_automatically: false,
    }, `credits-subscription-${org.id}`);
    subscriptionId = sub.id ?? sub.subscription?.id;
    if (!subscriptionId) throw new Error(`Meteroid created no subscription for ${org.slug}`);
  }
  await db.orgBilling.upsert({ where: { orgId: org.id }, create: { orgId: org.id, meteroidCustomerId: customer.id }, update: { meteroidCustomerId: customer.id } });
  return { customerId: customer.id, subscriptionId };
}

/**
 * An org's free trial credits (TRIAL_MINUTES, expiring TRIAL_DAYS after `startsAt`: a new org's creation; for an org
 * that existed before Meteroid, the day it was linked, given to scripts/meteroid-link-org.ts --trial). Once per org,
 * however often it runs for that customer: Meteroid answers a repeated key with the first grant only when the request is identical, so
 * the expiry comes from a fixed date, not the clock.
 */
export async function grantTrialMinutes(org: { id: string; createdAt: Date }, customerId: string, startsAt = org.createdAt) {
  await grantMinutes({
    customerId,
    minutes: TRIAL_MINUTES,
    type: "PROMOTIONAL",
    reason: "Free trial",
    expiresAt: new Date(startsAt.getTime() + TRIAL_DAYS * 86_400_000),
    // Meteroid keys are unique per tenant, not per customer: with the customer in it, a recreated customer can still get its trial.
    idempotencyKey: `trial-${org.id}-${customerId}`,
  });
}

/**
 * Undoes linkOrgToMeteroid for an org whose onboarding failed: cancels its subscriptions and archives the customer,
 * after moving its alias aside (an archived alias stays taken, and the founder may try the same slug again).
 */
export async function unlinkOrgFromMeteroid(customerId: string) {
  const subscriptions = (await meteroid<Page<{ id: string; status: string }>>("GET", `/subscriptions?customer_id=${customerId}&per_page=50`)).data ?? [];
  for (const sub of subscriptions.filter((s) => !["CANCELLED", "ENDED"].includes(s.status))) {
    await meteroid("POST", `/subscriptions/${sub.id}/cancel`, { effective_date: new Date().toISOString().slice(0, 10), reason: "Onboarding failed" });
  }
  await meteroid("PATCH", `/customers/${customerId}`, { alias: `${customerId}-onboarding-failed` });
  // A cancellation takes a moment to apply, and Meteroid won't archive a customer with an active subscription.
  for (let attempt = 1; ; attempt++) {
    try {
      return await meteroid("DELETE", `/customers/${customerId}`);
    } catch (error) {
      if (attempt >= ARCHIVE_ATTEMPTS || !(error instanceof MeteroidError && error.status === 400)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

const ARCHIVE_ATTEMPTS = 10;
