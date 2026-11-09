/**
 * One-time start of practice minutes (migration minute_ledger): every org gets a starting balance, then every learner
 * in it gets their minutes from that balance. An org that already has ledger rows is skipped, so it is safe to re-run.
 *
 *   bun scripts/minutes-backfill.ts                      dry run: what would be written
 *   bun scripts/minutes-backfill.ts --apply              write it
 *   bun scripts/minutes-backfill.ts --apply --org olga   one org
 *
 * Learners: enabled members with the learner role, plus people given a twin or role play (or invited as users) who
 * haven't joined yet. Admin and team get nothing (they never use minutes). Against a production database it also
 * needs --production.
 */
import { db } from "@/lib/db";
import { grantMinutes, MinutesError, orgBalanceSeconds, topUpOrg } from "@/lib/minutes";
import { LEARNER_ROLE, STUDIO_ROLES } from "@/lib/org";
import { isRemoteDatabase } from "./razorpay-script-guard";

const ORG_MINUTES = 1000;
const LEARNER_MINUTES = 60;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyOrg = args.includes("--org") ? args[args.indexOf("--org") + 1] : null;
const remote = isRemoteDatabase();
if (apply && remote && !args.includes("--production")) throw new Error("refusing: this is a production database; add --production to write to it");

/** Who in an org gets the learner minutes, by lower-case email. */
async function learnersOf(orgId: string) {
  const [members, studio, twins, roleplays, invitations] = await Promise.all([
    db.member.findMany({ where: { organizationId: orgId, role: LEARNER_ROLE, disabledAt: null }, select: { user: { select: { email: true } } } }),
    db.member.findMany({ where: { organizationId: orgId, role: { in: [...STUDIO_ROLES] } }, select: { user: { select: { email: true } } } }),
    db.twinAssignment.findMany({ where: { orgId, status: "active" }, select: { recipientEmail: true } }),
    db.rolePlayAssignment.findMany({ where: { orgId, status: { in: ["pending", "used"] } }, select: { recipientEmail: true } }),
    db.invitation.findMany({ where: { organizationId: orgId, role: LEARNER_ROLE, status: "pending", expiresAt: { gt: new Date() } }, select: { email: true } }),
  ]);
  const disabled = new Set((await db.member.findMany({ where: { organizationId: orgId, disabledAt: { not: null } }, select: { user: { select: { email: true } } } }))
    .map((row) => row.user.email.toLowerCase()));
  const staff = new Set(studio.map((row) => row.user.email.toLowerCase()));
  const emails = [
    ...members.map((row) => row.user.email),
    ...twins.map((row) => row.recipientEmail),
    ...roleplays.map((row) => row.recipientEmail),
    ...invitations.map((row) => row.email),
  ].map((email) => email.trim().toLowerCase());
  return [...new Set(emails)].filter((email) => !staff.has(email) && !disabled.has(email)).sort();
}

const orgs = await db.organization.findMany({ where: onlyOrg ? { slug: onlyOrg } : {}, orderBy: { slug: "asc" }, select: { id: true, slug: true } });
if (onlyOrg && !orgs.length) throw new Error(`No org "${onlyOrg}"`);
console.log(`${apply ? "APPLY" : "DRY RUN"} · ${remote ? "remote" : "local"} database · ${orgs.length} org(s)\n`);

for (const org of orgs) {
  const started = await db.minuteLedger.count({ where: { orgId: org.id } });
  if (started) {
    console.log(`${org.slug}: skipped (already has ${started} ledger rows; balance ${Math.floor((await orgBalanceSeconds(org.id)) / 60)} min)`);
    continue;
  }
  const learners = await learnersOf(org.id);
  const need = learners.length * LEARNER_MINUTES;
  const left = ORG_MINUTES - need;
  console.log(`${org.slug}: +${ORG_MINUTES} min to the org, ${learners.length} learner(s) × ${LEARNER_MINUTES} min = ${need} min → org keeps ${left} min`);
  for (const email of learners) console.log(`   ${email}`);
  if (left < 0) {
    console.log(`   NOT WRITTEN: ${ORG_MINUTES} min doesn't cover ${learners.length} learners; top up first or lower LEARNER_MINUTES`);
    continue;
  }
  if (!apply) continue;
  await topUpOrg({ orgId: org.id, minutes: ORG_MINUTES, note: "Starting balance" });
  for (const email of learners) {
    await grantMinutes({ orgId: org.id, email, minutes: LEARNER_MINUTES, note: "Starting minutes" }).catch((error: unknown) => {
      if (error instanceof MinutesError) console.log(`   ${email}: ${error.message}`);
      else throw error;
    });
  }
  console.log(`   written · org balance now ${Math.floor((await orgBalanceSeconds(org.id)) / 60)} min`);
}
await db.$disconnect();
