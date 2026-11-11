/**
 * The billing rules that must always hold (specs/billing.md, "Checks"). Read-only. Prints each check and exits 1 when
 * any fails. Run in rehearsals and after every release:
 *   bun scripts/check-billing.ts              (DATABASE_URL from web/.env)
 *   DATABASE_URL=<prod> bun scripts/check-billing.ts
 * "Overdue" = unpaid past its due date (overdue from 00:00 UTC the day after). The emails check allows an hour for
 * a workflow that is still running.
 */
import { db } from "@/lib/db";

const OVERDUE = `i.status = 'unpaid' and i."dueDate" < (now() at time zone 'utc')::date`;

export const BILLING_CHECKS = [
  {
    rule: "every paid org has a Paid subscription",
    sql: `select count(*)::int as n from "OrgBilling" where plan = 'paid' and "paidSubscriptionId" is null`,
  },
  {
    rule: "every trial org with a Paid subscription has an unpaid upgrade invoice",
    sql: `select count(*)::int as n from "OrgBilling" b where b.plan = 'trial' and b."paidSubscriptionId" is not null
            and not exists (select 1 from "BillingInvoice" i where i."orgId" = b."orgId" and i.kind = 'upgrade' and i.status = 'unpaid'
                            and i."subscriptionId" = b."paidSubscriptionId")
            and b."orgId" not in (select "orgId" from "BillingInvoice" where "createdAt" > now() - interval '1 hour')`,
  },
  {
    rule: "every paused org is paid and has an overdue unpaid renewal",
    sql: `select count(*)::int as n from "OrgBilling" b where b."pausedAt" is not null
            and (b.plan <> 'paid' or not exists (select 1 from "BillingInvoice" i where i."orgId" = b."orgId" and i.kind = 'renewal' and ${OVERDUE}))`,
  },
  {
    rule: "no unpaused paid org has an overdue renewal of its current subscription (allowing the 00:15 UTC check)",
    sql: `select count(*)::int as n from "OrgBilling" b where b.plan = 'paid' and b."pausedAt" is null
            and exists (select 1 from "BillingInvoice" i where i."orgId" = b."orgId" and i.kind = 'renewal' and i."subscriptionId" = b."paidSubscriptionId"
                        and i.status = 'unpaid' and i."dueDate" < (now() at time zone 'utc')::date - 1)`,
  },
  {
    rule: "every invoice copy belongs to a billed org and is above $0",
    sql: `select count(*)::int as n from "BillingInvoice" i where i."totalCents" <= 0 or not exists (select 1 from "OrgBilling" b where b."orgId" = i."orgId")`,
  },
  {
    rule: "every invoice older than an hour had its issued email, and every paid one its paid email",
    sql: `select count(*)::int as n from "BillingInvoice" i where i."createdAt" < now() - interval '1 hour'
            and ((i.status <> 'void' and i."issuedEmailAt" is null) or (i.status = 'paid' and i."paidEmailAt" is null and i."paidAt" < now() - interval '1 hour'))`,
  },
] as const;

/** Each check with how many rows break it (0 = holds). */
export async function checkBilling() {
  const results = [];
  for (const check of BILLING_CHECKS) {
    const [row] = await db.$queryRawUnsafe<{ n: number }[]>(check.sql);
    results.push({ rule: check.rule, broken: row.n });
  }
  return results;
}

if (import.meta.main) {
  const results = await checkBilling();
  for (const result of results) console.log(`${result.broken ? "FAIL" : "ok  "} ${result.rule}${result.broken ? ` (${result.broken})` : ""}`);
  await db.$disconnect();
  if (results.some((result) => result.broken)) process.exit(1);
}
