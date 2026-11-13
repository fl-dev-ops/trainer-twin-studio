import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { minuteGrants, minutesBalance, sendUsage, type CreditGrant } from "@/lib/meteroid";

/**
 * An org's credits (1 credit = 1 minute) live in Meteroid: what was added (grants with expiry) and what was spent.
 * The app spends them two ways, each a MinuteLedger row sent to Meteroid as a usage event (event id = row id):
 * minutes given to a learner (grant) and admin/team voice calls (org_usage). Until Meteroid has counted a row, the app
 * takes it off itself, so the same credits can't be spent twice. OrgBilling keeps the last balance Meteroid gave, for
 * pages and for when Meteroid can't be reached. An org without OrgBilling isn't billed: no credits, staff calls free.
 */

type Tx = Prisma.TransactionClient | typeof db;

const FRESH_TIMEOUT_MS = 2_500;
/** Waiting for Meteroid's balance to count a new or expired grant (it takes about 2-3 s). */
const RECOUNT_CHECKS = 5;
const RECOUNT_INTERVAL_MS = 2_000;

/** Seconds the app spent from the org that Meteroid hasn't counted as of `asOf`: rows not sent, or sent after it. */
async function uncountedSeconds(orgId: string, asOf: Date, tx: Tx) {
  const [row] = await tx.$queryRaw<{ seconds: number }[]>`
    SELECT coalesce(sum(CASE WHEN "type" = 'grant' THEN "seconds" ELSE -"seconds" END), 0)::int AS seconds
    FROM "MinuteLedger"
    WHERE "orgId" = ${orgId} AND "type" IN ('grant', 'org_usage') AND ("meteroidSentAt" IS NULL OR "meteroidSentAt" >= ${asOf})`;
  return row?.seconds ?? 0;
}

/**
 * Admin/team calls with no org_usage row yet: a live one holds its whole allowance (specs/practice.md rule 4, so two
 * trainers can't spend the same credits); an ended one counts the seconds it ran, up to its allowance.
 */
async function runningSeconds(orgId: string, tx: Tx) {
  const [row] = await tx.$queryRaw<{ seconds: number }[]>`
    SELECT coalesce(sum(CASE WHEN s."status" IN ('activating', 'active') THEN s."allowedSeconds"
      ELSE greatest(0, least(s."allowedSeconds",
        floor(extract(epoch FROM (coalesce(s."endedAt", now() AT TIME ZONE 'UTC') - s."startedAt"))))) END), 0)::int AS seconds
    FROM "InterviewSession" s
    WHERE s."orgId" = ${orgId} AND s."chargesOrg" AND s."allowedSeconds" IS NOT NULL
      AND (s."status" IN ('activating', 'active') OR s."startedAt" IS NOT NULL)
      AND s."status" NOT IN ('failed', 'revoked')
      AND NOT EXISTS (SELECT 1 FROM "MinuteLedger" m WHERE m."sessionId" = s."id")`;
  return row?.seconds ?? 0;
}

/**
 * Meteroid (2.2.1) doesn't take an expired grant off the balance until it next counts usage, and sends no
 * credit_grant.expired webhook (both seen on the dev tenant). Grants that expired after the balance was counted:
 * the balance still includes them.
 */
function lapsedSince(grants: CreditGrant[], asOf: Date, now = new Date()) {
  return grants.filter((grant) => grant.expiresAt && new Date(grant.expiresAt) <= now && new Date(grant.expiresAt) > asOf);
}

export type OrgCredits = { billed: boolean; seconds: number; minutes: number };

/**
 * What the org can still spend. `fresh`: ask Meteroid now (and keep the answer), falling back to the last answer
 * when it can't be reached; otherwise the last answer. Not billed by Meteroid: nothing to spend.
 */
export async function orgCredits(orgId: string, options: { fresh?: boolean; tx?: Tx } = {}): Promise<OrgCredits> {
  const tx = options.tx ?? db;
  const billing = await db.orgBilling.findUnique({ where: { orgId } });
  if (!billing) return { billed: false, seconds: 0, minutes: 0 };
  let balance = { minutes: billing.balanceMinutes, asOf: billing.balanceAsOf ?? new Date(0) };
  if (options.fresh) {
    try {
      // Short: callers may hold the org's grant lock (a transaction that times out at 5 s).
      balance = await minutesBalance(billing.meteroidCustomerId, FRESH_TIMEOUT_MS);
      await db.orgBilling.update({ where: { orgId }, data: { balanceMinutes: balance.minutes, balanceAsOf: balance.asOf } });
    } catch (error) {
      // Meteroid down, slow or refusing: the last balance it gave, less what was spent since, is still safe to use.
      console.error(`[org-credits] ${orgId}: using the last known balance:`, error instanceof Error ? error.message : error);
    }
  }
  // A grant expired that the balance still includes: take all of it off (safe: never spends expired minutes; may
  // briefly show less than is left) and have Meteroid count again.
  const lapsed = lapsedSince(billing.grants as CreditGrant[], balance.asOf);
  if (lapsed.length) {
    const { scheduleOrgSync } = await import("@/lib/schedule-org-credits"); // dynamic: that module imports the workflows, which import this one
    await scheduleOrgSync(orgId);
  }
  const seconds = (balance.minutes - lapsed.reduce((sum, grant) => sum + grant.minutes, 0)) * 60
    - (await uncountedSeconds(orgId, balance.asOf, tx)) - (await runningSeconds(orgId, tx));
  return { billed: true, seconds, minutes: Math.floor(seconds / 60) };
}

/** The org's credit grants as last read from Meteroid (Credits page), and their total. */
export async function orgGrants(orgId: string): Promise<{ grants: CreditGrant[]; syncedAt: Date | null } | null> {
  const billing = await db.orgBilling.findUnique({ where: { orgId }, select: { grants: true, syncedAt: true } });
  return billing ? { grants: billing.grants as CreditGrant[], syncedAt: billing.syncedAt } : null;
}

/**
 * Sends Meteroid every row of the org that spends its credits and wasn't sent yet. Safe to repeat or run twice at
 * once: Meteroid counts each event id once. Returns when the last one was sent (null: nothing to send).
 */
export async function sendOrgUsage(orgId: string): Promise<Date | null> {
  const billing = await db.orgBilling.findUnique({ where: { orgId }, select: { meteroidCustomerId: true } });
  if (!billing) return null;
  const rows = await db.minuteLedger.findMany({
    where: { orgId, type: { in: ["grant", "org_usage"] }, meteroidSentAt: null },
    select: { id: true, type: true, seconds: true, email: true, sessionId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  if (!rows.length) return null;
  await sendUsage(rows.map((row) => ({
    id: row.id,
    customerId: billing.meteroidCustomerId,
    minutes: Math.abs(row.seconds) / 60,
    at: row.createdAt,
    properties: { kind: row.type === "grant" ? "given_to_learner" : "staff_call", email: row.email ?? "", ...(row.sessionId ? { session: row.sessionId } : {}) },
  })));
  const sentAt = new Date();
  await db.minuteLedger.updateMany({ where: { id: { in: rows.map((row) => row.id) }, meteroidSentAt: null }, data: { meteroidSentAt: sentAt } });
  return sentAt;
}

/**
 * Reads the org's balance and grants from Meteroid into OrgBilling. `sentAt`: whether Meteroid has counted usage
 * sent then (its balance is as of a later moment).
 */
export async function refreshOrgCredits(orgId: string, sentAt?: Date | null): Promise<{ counted: boolean }> {
  const billing = await db.orgBilling.findUnique({ where: { orgId }, select: { meteroidCustomerId: true } });
  if (!billing) return { counted: true };
  const customerId = billing.meteroidCustomerId;
  const [grants, first] = await Promise.all([minuteGrants(customerId), minutesBalance(customerId)]);
  let balance = first;
  const lapsed = lapsedSince(grants, balance.asOf);
  if (lapsed.length) {
    // A zero-minute usage event makes Meteroid count again, without the expired grants (one per grant: same id).
    await sendUsage(lapsed.map((grant) => ({ id: `expired-${grant.id}`, customerId, minutes: 0, at: new Date(), properties: { kind: "recount_after_expiry", grant: grant.id } })));
  }
  // Meteroid sends wallet.funded before its balance counts the new grant (about 2 s later): wait for both.
  const behind = () => lapsedSince(grants, balance.asOf).length > 0 || grants.some((grant) => grant.createdAt && new Date(grant.createdAt) > balance.asOf);
  for (let check = 0; check < RECOUNT_CHECKS && behind(); check++) {
    await new Promise((resolve) => setTimeout(resolve, RECOUNT_INTERVAL_MS));
    balance = await minutesBalance(customerId);
  }
  await db.orgBilling.update({
    where: { orgId },
    data: { balanceMinutes: balance.minutes, balanceAsOf: balance.asOf, grants: grants as unknown as Prisma.InputJsonValue, syncedAt: new Date() },
  });
  return { counted: !sentAt || balance.asOf > sentAt };
}

/** The org billed by this Meteroid customer (webhooks). */
export async function orgOfCustomer(customerId: string) {
  return (await db.orgBilling.findUnique({ where: { meteroidCustomerId: customerId }, select: { orgId: true } }))?.orgId ?? null;
}

/** Whether the org has spending not sent to Meteroid yet (a workflow that didn't start or gave up). */
export async function hasUnsentUsage(orgId: string) {
  return (await db.minuteLedger.count({ where: { orgId, type: { in: ["grant", "org_usage"] }, meteroidSentAt: null }, take: 1 })) > 0;
}
